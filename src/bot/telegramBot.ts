import fs from 'fs'
import TelegramBot, {
	InlineKeyboardMarkup,
	SendMessageOptions,
	SendPhotoOptions,
} from 'node-telegram-bot-api'
import path from 'path'
import { config } from '../config/env'
import { checkIsAdminUser } from '../middleware/checkAdminRole'
import { prisma } from '../prisma'
import { logger } from '../utils/logger'

type ReleaseState = 'awaiting_content' | 'awaiting_confirm'

interface ReleaseDraft {
	text?: string
	photoFileId?: string // file_id из Telegram
}

interface ReleaseSession {
	adminTelegramId: string // строка, как приходит из Telegram
	chatId: number // куда показывать превью/статусы
	state: ReleaseState
	draft?: ReleaseDraft
	previewMessageId?: number // сообщение с превью (для скрытия кнопок)
	progressMessageId?: number // одно сообщение с прогрессом (редактируем)
	cancelRequested?: boolean // флаг отмены рассылки
}

/**
 * Класс для управления Telegram ботом
 * ИСПРАВЛЕНИЕ: Только один процесс (master) управляет ботом в кластере
 */
export class TelegramBotService {
	private bot: TelegramBot | null = null
	private isClusterMaster: boolean
	private releaseSessions: Map<string, ReleaseSession> = new Map()
	private warnedChats: Set<string> = new Set()

	// Настройки рассылки
	private static readonly BROADCAST_BATCH_SIZE = 25 // сколько сообщений параллельно
	private static readonly BROADCAST_DELAY_BETWEEN_BATCH = 1500 // мс пауза между батчами (~16-17 msg/s)
	private static readonly UPDATE_EVERY_BATCHES = 10 // как часто редактировать прогресс
	private static readonly GROUP_WARNING =
		'Этот бот не предназначен для групп и каналов. Пожалуйста, используйте приватный чат с ботом.'

	constructor() {
		// Проверяем, является ли процесс master в кластере
		this.isClusterMaster = !process.env.pm_id || process.env.pm_id === '0'

		// Инициализируем бота только в master процессе
		if (this.isClusterMaster) {
			logger.info(
				'🤖 Инициализация Telegram бота в master процессе',
				'TELEGRAM_BOT'
			)
			this.initializeBot()
		} else {
			logger.info(
				`⚠️ Процесс ${process.env.pm_id} пропускает инициализацию Telegram бота`,
				'TELEGRAM_BOT'
			)
		}
	}

	/**
	 * Инициализация бота (только в master процессе)
	 */
	private initializeBot() {
		try {
			this.bot = new TelegramBot(config.telegram.botToken, {
				polling: true,
				// Дополнительные настройки для стабильности
				request: {
					url: '',
					agentOptions: {
						keepAlive: true,
						family: 4, // Принудительно IPv4
					},
				} as any,
			})

			this.setupCommands()
			this.setupErrorHandlers()

			logger.info('✅ Telegram бот успешно инициализирован', 'TELEGRAM_BOT')
		} catch (error) {
			logger.error(
				'❌ Ошибка инициализации Telegram бота:',
				'TELEGRAM_BOT',
				error
			)
		}
	}

	/**
	 * Настройка обработчиков ошибок
	 */
	private setupErrorHandlers() {
		if (!this.bot) return

		this.bot.on('error', error => {
			logger.error('❌ Ошибка Telegram бота:', 'TELEGRAM_BOT', error)
		})

		this.bot.on('polling_error', error => {
			logger.error('❌ Ошибка polling Telegram бота:', 'TELEGRAM_BOT', error)
		})

		// Graceful restart при критических ошибках
		this.bot.on('webhook_error', error => {
			logger.error('❌ Критическая ошибка webhook:', 'TELEGRAM_BOT', error)
		})
	}

	/**
	 * Настройка обработчиков команд бота
	 */
	private setupCommands() {
		if (!this.bot) return

		// Обработчик для команды /start
		this.bot.onText(/\/start/, async msg => {
			try {
				const chatId = msg.chat.id
				const chatType = msg.chat.type
				const userName =
					msg.from?.username || msg.from?.first_name || 'пользователь'

				logger.info(
					`📱 Команда /start от пользователя: ${userName} (${chatId})`,
					'TELEGRAM_BOT'
				)
				if (chatType !== 'private') {
					const key = String(chatId)
					if (!this.warnedChats.has(key)) {
						await this.bot?.sendMessage(
							chatId,
							TelegramBotService.GROUP_WARNING
						)
						this.warnedChats.add(key)
					}
					return
				}
				await this.sendWebAppButton(chatId, chatType)
			} catch (error) {
				logger.error(
					'❌ Ошибка обработки команды /start:',
					'TELEGRAM_BOT',
					error
				)
			}
		})

		// Обработчик для команды /cleanup (только для админов)
		this.bot.onText(/\/cleanup/, async msg => {
			const chatId = msg.chat.id
			const telegramId = msg.from?.id?.toString()
			const userName =
				msg.from?.username || msg.from?.first_name || 'пользователь'

			try {
				logger.info(
					`🧹 Команда /cleanup от пользователя: ${userName} (${chatId})`,
					'TELEGRAM_BOT'
				)

				if (!telegramId) {
					await this.bot?.sendMessage(
						chatId,
						'❌ Не удалось определить ваш ID пользователя'
					)
					return
				}

				// Проверяем, является ли пользователь админом
				const isAdmin = await checkIsAdminUser(telegramId)
				if (!isAdmin) {
					await this.bot?.sendMessage(
						chatId,
						'❌ Доступ запрещен. Эта команда доступна только администраторам.'
					)
					return
				}

				// Отправляем сообщение о начале очистки
				const processingMsg = await this.bot?.sendMessage(
					chatId,
					'🧹 Начинаю очистку потерянных записей статистики...'
				)

				try {
					// Выполняем очистку потерянных статистик
					let totalDeletedStats = 0

					await prisma.$transaction(async (tx: any) => {
						// 1. Находим статистики с несуществующими игроками через сырой SQL
						const orphanedStatsQuery = (await tx.$queryRaw`
							SELECT ps.id, ps.player_id, ps.club_id, ps.category_name
							FROM player_statistics ps
							LEFT JOIN players p ON ps.player_id = p.id
							LEFT JOIN clubs c ON ps.club_id = c.id
							WHERE p.id IS NULL OR c.id IS NULL
						`) as Array<{
							id: string
							player_id: string
							club_id: string
							category_name: string
						}>

						if (orphanedStatsQuery.length > 0) {
							logger.info(
								`🗑️ Найдено ${orphanedStatsQuery.length} потерянных статистик`,
								'TELEGRAM_BOT'
							)

							const deleted = await tx.playerStatistics.deleteMany({
								where: {
									id: {
										in: orphanedStatsQuery.map((stat: any) => stat.id),
									},
								},
							})

							totalDeletedStats += deleted.count
							logger.info(
								`✅ Удалено ${deleted.count} потерянных статистик`,
								'TELEGRAM_BOT'
							)
						}
					})

					// Отправляем результат
					let resultMessage = ''
					if (totalDeletedStats > 0) {
						resultMessage = `✅ Очистка завершена успешно!\n\n📊 Удалено ${totalDeletedStats} потерянных записей статистики`
					} else {
						resultMessage =
							'✅ Очистка завершена!\n\n📊 Потерянных записей статистики не найдено. База данных в порядке.'
					}

					// Обновляем сообщение с результатом
					if (processingMsg) {
						await this.bot?.editMessageText(resultMessage, {
							chat_id: chatId,
							message_id: processingMsg.message_id,
						})
					} else {
						await this.bot?.sendMessage(chatId, resultMessage)
					}

					logger.info(
						`✅ Очистка статистик завершена для админа ${userName}: удалено ${totalDeletedStats} записей`,
						'TELEGRAM_BOT'
					)
				} catch (cleanupError) {
					logger.error(
						'❌ Ошибка при очистке потерянных статистик:',
						'TELEGRAM_BOT',
						cleanupError
					)

					const errorMessage =
						'❌ Произошла ошибка при очистке потерянных статистик.\n\nОбратитесь к технической поддержке.'

					// Обновляем сообщение с ошибкой
					if (processingMsg) {
						await this.bot?.editMessageText(errorMessage, {
							chat_id: chatId,
							message_id: processingMsg.message_id,
						})
					} else {
						await this.bot?.sendMessage(chatId, errorMessage)
					}
				}
			} catch (error) {
				logger.error(
					'❌ Ошибка обработки команды /cleanup:',
					'TELEGRAM_BOT',
					error
				)
				await this.bot?.sendMessage(
					chatId,
					'❌ Произошла ошибка при обработке команды'
				)
			}
		})

		// /release (только для админов)
		this.bot.onText(/\/release/, async msg => {
			const chatId = msg.chat.id
			const telegramId = msg.from?.id?.toString()
			const userName =
				msg.from?.username || msg.from?.first_name || 'пользователь'

			try {
				logger.info(
					`🚀 Команда /release от ${userName} (${chatId})`,
					'TELEGRAM_BOT'
				)

				if (!telegramId) {
					await this.bot?.sendMessage(
						chatId,
						'❌ Не удалось определить ваш ID пользователя'
					)
					return
				}

				const isAdmin = await checkIsAdminUser(telegramId)
				if (!isAdmin) {
					await this.bot?.sendMessage(
						chatId,
						'❌ Доступ запрещен. Команда только для админов.'
					)
					return
				}

				// Сброс предыдущей сессии, если была
				this.releaseSessions.delete(telegramId)

				// Старт новой сессии
				this.releaseSessions.set(telegramId, {
					adminTelegramId: telegramId,
					chatId,
					state: 'awaiting_content',
					cancelRequested: false,
				})

				await this.bot?.sendMessage(
					chatId,
					'📝 Пришлите текст релиза одним сообщением ИЛИ фото с подписью. После этого я покажу превью с кнопками подтверждения.'
				)
			} catch (error) {
				logger.error('❌ Ошибка обработки /release:', 'TELEGRAM_BOT', error)
				await this.bot?.sendMessage(
					chatId,
					'❌ Произошла ошибка при обработке команды'
				)
			}
		})

		// callback_query для подтверждения/отмены релиза и остановки рассылки
		this.bot.on('callback_query', async query => {
			try {
				if (!query.data || !query.from?.id) return
				const telegramId = query.from.id.toString()
				const session = this.releaseSessions.get(telegramId)
				const data = query.data

				// Отдельная обработка кнопки остановки, даже если сессия не найдена (на всякий случай)
				if (data === 'release_stop') {
					if (!session) {
						await this.bot?.answerCallbackQuery(query.id, {
							text: 'Сессия не найдена.',
						})
						return
					}
					session.cancelRequested = true
					this.releaseSessions.set(telegramId, session)
					await this.bot?.answerCallbackQuery(query.id, {
						text: '⛔ Остановка запрошена.',
					})
					// Скрываем кнопку стоп, чтобы не тыкали по сто раз
					if (session.progressMessageId) {
						await this.safeEditProgress(
							session,
							`⛔ Остановка запрошена...`,
							true /*removeKeyboard*/
						)
					}
					return
				}

				if (!session) return

				const isAdmin = await checkIsAdminUser(telegramId).catch(() => false)
				if (!isAdmin) {
					await this.bot?.answerCallbackQuery(query.id, {
						text: '⛔ Не для вас.',
					})
					return
				}

				if (data === 'release_cancel') {
					this.releaseSessions.delete(telegramId)
					await this.bot?.answerCallbackQuery(query.id, { text: 'Отменено.' })
					// Прячем кнопки у превью
					if (session.previewMessageId) {
						await this.bot!.editMessageReplyMarkup(
							{ inline_keyboard: [] },
							{ chat_id: session.chatId, message_id: session.previewMessageId }
						)
					}
					await this.bot?.sendMessage(session.chatId, '❌ Рассылка отменена.')
					return
				}

				if (data === 'release_confirm') {
					if (!session.draft) {
						await this.bot?.answerCallbackQuery(query.id, {
							text: 'Нет данных для отправки.',
						})
						return
					}

					await this.bot?.answerCallbackQuery(query.id, {
						text: 'Отправляю всем...',
					})
					// Прячем кнопки у превью
					if (session.previewMessageId) {
						await this.bot!.editMessageReplyMarkup(
							{ inline_keyboard: [] },
							{ chat_id: session.chatId, message_id: session.previewMessageId }
						)
					}

					// Создаем одно сообщение прогресса с кнопкой «Остановить»
					const progress = await this.bot?.sendMessage(
						session.chatId,
						'📊 Прогресс: 0/0. Успешно: 0, ошибок: 0.',
						{
							reply_markup: {
								inline_keyboard: [
									[
										{
											text: '❌ Остановить рассылку',
											callback_data: 'release_stop',
										},
									],
								],
							},
						}
					)
					session.progressMessageId = progress?.message_id
					this.releaseSessions.set(telegramId, session)

					try {
						await this.broadcastRelease(session)
						// финальная сводка редактированием того же сообщения
						await this.safeEditProgress(
							session,
							'🏁 Готово.',
							true /*removeKeyboard*/
						)
					} catch (e) {
						logger.error('❌ Ошибка в broadcastRelease:', 'TELEGRAM_BOT', e)
						await this.safeEditProgress(
							session,
							'❌ Произошла ошибка при рассылке.',
							true
						)
					} finally {
						this.releaseSessions.delete(telegramId)
					}
				}
			} catch (e) {
				logger.error(
					'❌ Ошибка в callback_query обработчике:',
					'TELEGRAM_BOT',
					e
				)
			}
		})

		// Обработчик для всех остальных команд
		this.bot.on('message', async msg => {
			try {
				const chatId = msg.chat.id
				const chatType = msg.chat.type
				const telegramId = msg.from?.id?.toString()

				// Ограничение для групп/каналов: показать предупреждение один раз
				if (chatType !== 'private') {
					const key = String(chatId)
					if (!this.warnedChats.has(key)) {
						await this.bot?.sendMessage(
							chatId,
							TelegramBotService.GROUP_WARNING
						)
						this.warnedChats.add(key)
					}
					return
				}

				// Если есть сессия релиза — обрабатываем её в приоритете
				if (telegramId) {
					const session = this.releaseSessions.get(telegramId)
					if (session) {
						// Только админ может взаимодействовать с сессией
						const isAdmin = await checkIsAdminUser(telegramId).catch(
							() => false
						)
						if (isAdmin && session.state === 'awaiting_content') {
							const hasPhoto = !!msg.photo && msg.photo.length > 0
							const caption =
								typeof msg.caption === 'string' ? msg.caption.trim() : undefined
							const textOnly =
								typeof msg.text === 'string' ? msg.text.trim() : undefined

							if (!hasPhoto && !textOnly) {
								await this.bot?.sendMessage(
									session.chatId,
									'❌ Нужно отправить текст или фото с подписью.'
								)
								return
							}

							const draft: ReleaseDraft = {}
							if (hasPhoto) {
								const best = msg.photo!.slice(-1)[0]
								draft.photoFileId = best.file_id
								if (caption) draft.text = caption
							} else if (textOnly) {
								draft.text = textOnly
							}

							session.draft = draft
							session.state = 'awaiting_confirm'
							this.releaseSessions.set(telegramId, session)

							await this.bot?.sendMessage(
								session.chatId,
								'👀 Превью релиза. Подтвердите отправку всем.'
							)
							const previewId = await this.sendReleasePreview(session)
							if (previewId) {
								session.previewMessageId = previewId
								this.releaseSessions.set(telegramId, session)
							}
							return
						}

						if (isAdmin && session.state === 'awaiting_confirm') {
							await this.bot?.sendMessage(
								session.chatId,
								'ℹ️ Используйте кнопки ✅ или ❌ под превью для подтверждения или отмены.'
							)
							return
						}
					}
				}

				// Дефолт: показать кнопку веб-аппа
				if (
					msg.text &&
					!msg.text.startsWith('/start') &&
					!msg.text.startsWith('/cleanup') &&
					!msg.text.startsWith('/release')
				) {
					await this.sendWebAppButton(chatId, chatType)
				}
			} catch (error) {
				logger.error('❌ Ошибка обработки сообщения:', 'TELEGRAM_BOT', error)
			}
		})
	}

	/**
	 * Отправляет сообщение с кнопкой для открытия веб-приложения
	 */
	private async sendWebAppButton(chatId: number, chatType?: string) {
		if (!this.bot) {
			logger.warn(
				'⚠️ Попытка отправить сообщение, но бот не инициализирован!',
				'TELEGRAM_BOT'
			)
			return
		}

		try {
			let messageText = 'Добро пожаловать в Myach Pro! ⚽'
			let markup: any = {}

			const type = chatType ?? (await this.getChatTypeSafe(chatId))
			const isPrivate = type === 'private'

			if (config.webApp.url.startsWith('https://')) {
				if (isPrivate) {
					messageText += '\n\nНажмите кнопку ниже, чтобы создать свой тир-лист:'
					const inlineKeyboard = [
						[{ text: 'Открыть Тир Лист', web_app: { url: config.webApp.url } }],
					]
					markup = { reply_markup: { inline_keyboard: inlineKeyboard } }
				} else {
					messageText += `\n\nНажмите кнопку или перейдите по ссылке, чтобы открыть приложение: ${config.webApp.url}`
					const inlineKeyboard = [
						[{ text: 'Открыть Тир Лист', url: config.webApp.url }],
					]
					markup = { reply_markup: { inline_keyboard: inlineKeyboard } }
				}
			} else {
				messageText += `\n\n🔗 Для открытия приложения перейдите по ссылке: ${config.webApp.url}\n\n⚠️ Внимание: WebApp кнопки работают только с HTTPS URL`
			}

			await this.bot.sendMessage(chatId, messageText, markup)
			logger.info(
				`✅ Сообщение отправлено пользователю ${chatId}`,
				'TELEGRAM_BOT'
			)
		} catch (error) {
			logger.error('❌ Ошибка отправки сообщения:', 'TELEGRAM_BOT', error)
		}
	}

	/**
	 * Кнопка запуска мини-аппа
	 */
	private buildAppKeyboard(
		chatType?: string
	): SendMessageOptions | SendPhotoOptions {
		const inlineKeyboard: any[] = []
		const isPrivate = chatType === 'private'
		if (config.webApp.url.startsWith('https://')) {
			if (isPrivate) {
				inlineKeyboard.push([
					{ text: 'Открыть Тир Лист', web_app: { url: config.webApp.url } },
				])
			} else {
				inlineKeyboard.push([
					{ text: 'Открыть Тир Лист', url: config.webApp.url },
				])
			}
		}
		return inlineKeyboard.length
			? { reply_markup: { inline_keyboard: inlineKeyboard } }
			: {}
	}

	/**
	 * Безопасно получает тип чата: 'private' | 'group' | 'supergroup' | 'channel'
	 */
	private async getChatTypeSafe(
		chatId: number | string
	): Promise<string | undefined> {
		if (!this.bot) return
		try {
			const chat: any = await this.bot.getChat(chatId as any)
			return chat?.type
		} catch {
			return undefined
		}
	}

	/**
	 * Превью релиза админу
	 */
	private async sendReleasePreview(
		session: ReleaseSession
	): Promise<number | undefined> {
		const { chatId, draft } = session
		if (!this.bot || !draft) return

		const confirmKeyboard: InlineKeyboardMarkup = {
			inline_keyboard: [
				[{ text: '✅ Отправить всем', callback_data: 'release_confirm' }],
				[{ text: '❌ Отменить', callback_data: 'release_cancel' }],
			],
		}

		if (draft.photoFileId) {
			const m = await this.bot.sendPhoto(chatId, draft.photoFileId, {
				caption: draft.text || '',
				reply_markup: confirmKeyboard,
			})
			return m.message_id
		} else {
			const m = await this.bot.sendMessage(chatId, draft.text || '(пусто)', {
				reply_markup: confirmKeyboard,
			})
			return m.message_id
		}
	}

	/**
	 * Безопасное редактирование прогресса. Можно убрать клавиатуру.
	 */
	private async safeEditProgress(
		session: ReleaseSession,
		text: string,
		removeKeyboard = false
	) {
		if (!this.bot || !session.progressMessageId) return
		try {
			await this.bot.editMessageText(text, {
				chat_id: session.chatId,
				message_id: session.progressMessageId,
				reply_markup: removeKeyboard
					? { inline_keyboard: [] }
					: {
							inline_keyboard: [
								[
									{
										text: '❌ Остановить рассылку',
										callback_data: 'release_stop',
									},
								],
							],
					  },
			} as any)
		} catch (e: any) {
			const retryAfter =
				e?.response?.body?.parameters?.retry_after ||
				e?.response?.parameters?.retry_after
			if (retryAfter) {
				await new Promise(r => setTimeout(r, Number(retryAfter) * 1000))
				try {
					await this.bot.editMessageText(text, {
						chat_id: session.chatId,
						message_id: session.progressMessageId,
						reply_markup: removeKeyboard
							? { inline_keyboard: [] }
							: {
									inline_keyboard: [
										[
											{
												text: '❌ Остановить рассылку',
												callback_data: 'release_stop',
											},
										],
									],
							  },
					} as any)
				} catch {
					/* ладно, переживём */
				}
			}
		}
	}

	/**
	 * Массовая рассылка по базе
	 */
	private async broadcastRelease(session: ReleaseSession) {
		if (!this.bot || !session.draft) return
		const appKeyboard = this.buildAppKeyboard()
		const draft = session.draft

		// Берём всех пользователей
		const users = await prisma.user.findMany({
			select: { telegramId: true },
		})

		// Чат-айди как строки (без потери точности), не шлём админу
		const audience: string[] = users
			.map(u => String((u as any).telegramId))
			.filter(s => !!s && s !== session.adminTelegramId)

		const total = audience.length
		logger.info(`📣 Начинаем рассылку: ${total} получателей`, 'TELEGRAM_BOT')

		// Если нет прогресс-сообщения — создадим (на всякий)
		if (!session.progressMessageId) {
			const m = await this.bot!.sendMessage(
				session.chatId,
				'📊 Прогресс: 0/0. Успешно: 0, ошибок: 0.',
				{
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: '❌ Остановить рассылку',
									callback_data: 'release_stop',
								},
							],
						],
					},
				}
			)
			session.progressMessageId = m.message_id
			this.releaseSessions.set(session.adminTelegramId, session)
		}

		// Разбиваем на батчи
		const batches: string[][] = []
		for (
			let i = 0;
			i < audience.length;
			i += TelegramBotService.BROADCAST_BATCH_SIZE
		) {
			batches.push(
				audience.slice(i, i + TelegramBotService.BROADCAST_BATCH_SIZE)
			)
		}

		let sent = 0
		let failed = 0
		let lastEditedBatch = -1

		// функция обновления текста прогресса
		const updateProgress = async () => {
			await this.safeEditProgress(
				session,
				`📊 Прогресс: ${Math.min(
					sent + failed,
					total
				)}/${total}. Успешно: ${sent}, ошибок: ${failed}.`
			)
		}

		for (let b = 0; b < batches.length; b++) {
			// проверка отмены перед каждым батчем
			if (session.cancelRequested) {
				await this.safeEditProgress(
					session,
					`⛔ Рассылка остановлена.\nОтправлено: ${sent}\nОшибок: ${failed}\nВсего было получателей: ${total}`,
					true
				)
				logger.warn(
					`⛔ Рассылка остановлена админом. sent=${sent}, failed=${failed}`,
					'TELEGRAM_BOT'
				)
				return
			}

			const batch = batches[b]

			const results = await Promise.allSettled(
				batch.map(async chatIdStr => {
					try {
						if (draft.photoFileId) {
							await this.bot!.sendPhoto(chatIdStr, draft.photoFileId!, {
								caption: draft.text || '',
								...(appKeyboard as SendPhotoOptions),
							})
						} else {
							await this.bot!.sendMessage(
								chatIdStr,
								draft.text || '',
								appKeyboard as any
							)
						}
						return true
					} catch (e: any) {
						const retryAfter =
							e?.response?.body?.parameters?.retry_after ||
							e?.response?.parameters?.retry_after
						if (retryAfter && Number.isFinite(Number(retryAfter))) {
							await new Promise(r => setTimeout(r, Number(retryAfter) * 1000))
							try {
								if (draft.photoFileId) {
									await this.bot!.sendPhoto(chatIdStr, draft.photoFileId!, {
										caption: draft.text || '',
										...(appKeyboard as SendPhotoOptions),
									})
								} else {
									await this.bot!.sendMessage(
										chatIdStr,
										draft.text || '',
										appKeyboard as any
									)
								}
								return true
							} catch (e2) {
								throw e2
							}
						}
						throw e
					}
				})
			)

			for (const r of results) {
				if (r.status === 'fulfilled' && r.value === true) sent++
				else failed++
			}

			// редактируем одно прогресс-сообщение не слишком часто
			if (b - lastEditedBatch >= TelegramBotService.UPDATE_EVERY_BATCHES) {
				await updateProgress()
				lastEditedBatch = b
			}

			// пауза между батчами
			if (b < batches.length - 1) {
				await new Promise(r =>
					setTimeout(r, TelegramBotService.BROADCAST_DELAY_BETWEEN_BATCH)
				)
			}
		}

		// финальное редактирование прогресса
		await this.safeEditProgress(
			session,
			`✅ Рассылка завершена.\nОтправлено: ${sent}\nОшибок: ${failed}\nВсего получателей: ${total}`,
			true
		)

		logger.info(
			`🏁 Рассылка завершена: всего=${total}, отправлено=${sent}, ошибок=${failed}`,
			'TELEGRAM_BOT'
		)
	}

	/**
	 * Отправка изображения через бота (для кроссплатформенного шэринга)
	 */
	public async sendImage(
		chatId: number,
		imageBuffer: Buffer,
		caption?: string
	): Promise<boolean> {
		// Дополнительная диагностика входящего Buffer
		logger.info(
			`🔍 TelegramBotService.sendImage вызван: chatId=${chatId}, buffer существует=${!!imageBuffer}, размер=${
				imageBuffer?.length || 0
			}, тип=${typeof imageBuffer}`,
			'TELEGRAM_BOT'
		)

		if (!this.bot) {
			logger.warn(
				'⚠️ Попытка отправить изображение, но бот не инициализирован',
				'TELEGRAM_BOT'
			)
			return false
		}

		// Валидация Buffer изображения
		if (!imageBuffer || imageBuffer.length === 0) {
			logger.error(
				'❌ Buffer изображения пустой или не определен',
				'TELEGRAM_BOT'
			)
			return false
		}

		// Проверяем что это действительно Buffer
		if (!Buffer.isBuffer(imageBuffer)) {
			logger.error(
				`❌ Переданный объект не является Buffer: тип=${typeof imageBuffer}, конструктор=${
					(imageBuffer as any)?.constructor?.name
				}`,
				'TELEGRAM_BOT'
			)
			return false
		}

		// Проверяем что Buffer содержит валидные JPEG данные
		const isValidJPEG = this.validateJPEGBuffer(imageBuffer)
		if (!isValidJPEG) {
			logger.error(
				'❌ Buffer не содержит валидных JPEG данных, принудительно используем файловый метод',
				'TELEGRAM_BOT'
			)

			// Сразу пробуем файловый метод при невалидном Buffer
			try {
				return await this.sendImageViaFile(chatId, imageBuffer, caption)
			} catch (fileError) {
				logger.error(
					'❌ Файловый метод также не сработал:',
					'TELEGRAM_BOT',
					fileError
				)
				return false
			}
		}

		// Проверяем размер изображения
		const imageSizeMB = imageBuffer.length / (1024 * 1024)
		logger.info(
			`📷 Попытка отправки валидного изображения: ${imageSizeMB.toFixed(
				2
			)}MB для пользователя ${chatId}`,
			'TELEGRAM_BOT'
		)

		// Если изображение слишком большое, пробуем уменьшить качество
		if (imageSizeMB > 5) {
			logger.warn(
				`⚠️ Изображение слишком большое (${imageSizeMB.toFixed(
					2
				)}MB), может быть проблема с отправкой`,
				'TELEGRAM_BOT'
			)
		}

		let attempt = 0
		const maxAttempts = 3

		while (attempt < maxAttempts) {
			try {
				attempt++
				logger.info(
					`🔄 Попытка отправки #${attempt} для пользователя ${chatId}`,
					'TELEGRAM_BOT'
				)

				// Используем setTimeout для разбивания цепочки вызовов
				const result = await new Promise<boolean>((resolve, reject) => {
					setTimeout(async () => {
						try {
							if (!this.bot) {
								throw new Error('Бот недоступен')
							}

							// Определяем тип чата и создаём инлайн кнопку
							const chatType = await this.getChatTypeSafe(chatId)
							const isPrivate = chatType === 'private'
							const inlineKeyboard: any[] = []
							if (config.webApp.url.startsWith('https://')) {
								inlineKeyboard.push([
									isPrivate
										? {
												text: '🎯 Создать свой тир-лист',
												web_app: { url: config.webApp.url },
										  }
										: {
												text: '🎯 Создать свой тир-лист',
												url: config.webApp.url,
										  },
								])
							}

							await this.bot.sendPhoto(chatId, imageBuffer, {
								caption: caption || 'Ваш тир-лист готов! 🎯',
								reply_markup: {
									inline_keyboard: inlineKeyboard,
								},
							})

							logger.info(
								`✅ Изображение успешно отправлено пользователю ${chatId} (попытка ${attempt})`,
								'TELEGRAM_BOT'
							)
							resolve(true)
						} catch (error) {
							reject(error)
						}
					}, attempt * 1000) // Увеличиваем задержку с каждой попыткой
				})

				return result
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error)

				logger.error(
					`❌ Ошибка отправки изображения (попытка ${attempt}/${maxAttempts}):`,
					'TELEGRAM_BOT',
					error
				)

				// Если это ошибка с Buffer file-type или переполнение стека, пробуем альтернативный метод
				if (
					errorMessage.includes('Maximum call stack size exceeded') ||
					errorMessage.includes('Unsupported Buffer file-type') ||
					errorMessage.includes('EFATAL')
				) {
					logger.warn(
						`🔄 Обнаружена ошибка Buffer/стека, пробуем отправку через файл`,
						'TELEGRAM_BOT'
					)

					try {
						const fileResult = await this.sendImageViaFile(
							chatId,
							imageBuffer,
							caption
						)
						if (fileResult) {
							logger.info(
								`✅ Изображение успешно отправлено через файл после ошибки Buffer`,
								'TELEGRAM_BOT'
							)
							return true
						}
					} catch (fileError) {
						logger.error(
							'❌ Ошибка отправки через файл:',
							'TELEGRAM_BOT',
							fileError
						)
					}

					if (attempt < maxAttempts) {
						await new Promise(resolve => setTimeout(resolve, attempt * 2000))
						continue
					}
				}

				// Если это последняя попытка или не переполнение стека
				if (attempt >= maxAttempts) {
					logger.error(
						`❌ Не удалось отправить изображение после ${maxAttempts} попыток`,
						'TELEGRAM_BOT'
					)
					return false
				}

				// Ждем перед следующей попыткой
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
			}
		}

		return false
	}

	/**
	 * Валидирует что Buffer содержит корректные JPEG данные
	 */
	private validateJPEGBuffer(buffer: Buffer): boolean {
		try {
			if (!buffer || buffer.length < 10) {
				return false
			}

			// Проверяем JPEG заголовок (FF D8 FF)
			const jpegHeader = buffer.subarray(0, 3)
			const isJPEG =
				jpegHeader[0] === 0xff &&
				jpegHeader[1] === 0xd8 &&
				jpegHeader[2] === 0xff

			if (!isJPEG) {
				logger.error(
					`❌ Buffer не содержит JPEG заголовка: ${jpegHeader.toString('hex')}`,
					'TELEGRAM_BOT'
				)
				return false
			}

			// Проверяем JPEG окончание (FF D9)
			const jpegFooter = buffer.subarray(-2)
			const hasValidEnd = jpegFooter[0] === 0xff && jpegFooter[1] === 0xd9

			if (!hasValidEnd) {
				logger.warn(
					`⚠️ Buffer не имеет корректного JPEG окончания, но имеет заголовок`,
					'TELEGRAM_BOT'
				)
				// Возвращаем true, так как основной заголовок есть
				return true
			}

			return true
		} catch (error) {
			logger.error(
				'❌ Ошибка при валидации JPEG Buffer:',
				'TELEGRAM_BOT',
				error as Error
			)
			return false
		}
	}

	/**
	 * Альтернативный метод отправки изображения через временный файл
	 * Используется как fallback при проблемах с Buffer
	 */
	private async sendImageViaFile(
		chatId: number,
		imageBuffer: Buffer,
		caption?: string
	): Promise<boolean> {
		const tempDir = path.join(process.cwd(), 'tmp')
		const tempFileName = `temp_image_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}.jpg`
		const tempFilePath = path.join(tempDir, tempFileName)

		try {
			// Создаем папку tmp если её нет
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true })
			}

			// Записываем изображение во временный файл
			fs.writeFileSync(tempFilePath, imageBuffer)

			// Проверяем что файл записался корректно
			if (!fs.existsSync(tempFilePath)) {
				throw new Error('Временный файл не был создан')
			}

			const fileStats = fs.statSync(tempFilePath)
			if (fileStats.size === 0) {
				throw new Error('Временный файл пустой')
			}

			if (fileStats.size !== imageBuffer.length) {
				logger.warn(
					`⚠️ Размер записанного файла (${fileStats.size}) не совпадает с размером Buffer (${imageBuffer.length})`,
					'TELEGRAM_BOT'
				)
			}

			logger.info(
				`💾 Временный файл создан: ${tempFilePath} (${fileStats.size} байт)`,
				'TELEGRAM_BOT'
			)

			if (!this.bot) {
				throw new Error('Бот недоступен')
			}

			// Определяем тип чата и создаём инлайн кнопку
			const chatType = await this.getChatTypeSafe(chatId)
			const isPrivate = chatType === 'private'
			const inlineKeyboard: any[] = []
			if (config.webApp.url.startsWith('https://')) {
				inlineKeyboard.push([
					isPrivate
						? {
								text: '🎯 Создать свой тир-лист',
								web_app: { url: config.webApp.url },
						  }
						: { text: '🎯 Создать свой тир-лист', url: config.webApp.url },
				])
			}

			// Отправляем файл
			await this.bot.sendPhoto(chatId, tempFilePath, {
				caption: caption || 'Ваш тир-лист готов! 🎯',
				reply_markup: {
					inline_keyboard: inlineKeyboard,
				},
			})

			logger.info(
				`✅ Изображение отправлено через файл для пользователя ${chatId}`,
				'TELEGRAM_BOT'
			)

			return true
		} catch (error) {
			logger.error(
				'❌ Ошибка отправки изображения через файл:',
				'TELEGRAM_BOT',
				error
			)
			return false
		} finally {
			// Удаляем временный файл
			try {
				if (fs.existsSync(tempFilePath)) {
					fs.unlinkSync(tempFilePath)
				}
			} catch (cleanupError) {
				logger.error(
					'⚠️ Ошибка удаления временного файла:',
					'TELEGRAM_BOT',
					cleanupError
				)
			}
		}
	}

	/**
	 * Возвращает экземпляр бота (может быть null в worker процессах)
	 */
	public getBot(): TelegramBot | null {
		return this.bot
	}

	/**
	 * Проверка доступности бота
	 */
	public isBotAvailable(): boolean {
		return this.isClusterMaster && this.bot !== null
	}

	/**
	 * Graceful shutdown бота
	 */
	public async shutdown(): Promise<void> {
		if (this.bot && this.isClusterMaster) {
			logger.info('🔄 Остановка Telegram бота...', 'TELEGRAM_BOT')
			try {
				await this.bot.stopPolling()
				logger.info('✅ Telegram бот остановлен', 'TELEGRAM_BOT')
			} catch (error) {
				logger.error('❌ Ошибка при остановке бота:', 'TELEGRAM_BOT', error)
			}
		}
	}
}
