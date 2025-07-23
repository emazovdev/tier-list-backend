import fs from 'fs'
import TelegramBot from 'node-telegram-bot-api'
import path from 'path'
import { config } from '../config/env'
import { checkIsAdminUser } from '../middleware/checkAdminRole'
import { prisma } from '../prisma'
import { logger } from '../utils/logger'

/**
 * Класс для управления Telegram ботом
 * ИСПРАВЛЕНИЕ: Только один процесс (master) управляет ботом в кластере
 */
export class TelegramBotService {
	private bot: TelegramBot | null = null
	private isClusterMaster: boolean

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
				const userName =
					msg.from?.username || msg.from?.first_name || 'пользователь'

				logger.info(
					`📱 Команда /start от пользователя: ${userName} (${chatId})`,
					'TELEGRAM_BOT'
				)
				await this.sendWebAppButton(chatId)
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

		// Обработчик для всех остальных команд
		this.bot.on('message', async msg => {
			if (
				msg.text &&
				!msg.text.startsWith('/start') &&
				!msg.text.startsWith('/cleanup')
			) {
				try {
					const chatId = msg.chat.id
					await this.sendWebAppButton(chatId)
				} catch (error) {
					logger.error('❌ Ошибка обработки сообщения:', 'TELEGRAM_BOT', error)
				}
			}
		})
	}

	/**
	 * Отправляет сообщение с кнопкой для открытия веб-приложения
	 */
	private async sendWebAppButton(chatId: number) {
		if (!this.bot) {
			logger.warn(
				'⚠️ Попытка отправить сообщение, но бот не инициализирован!',
				'TELEGRAM_BOT'
			)
			return
		}

		try {
			// Проверяем, что URL соответствует требованиям Telegram (https)
			let messageText = 'Добро пожаловать в Myach Pro! ⚽'
			let markup: any = {}

			// URL должен начинаться с https:// для работы с Telegram WebApp
			if (config.webApp.url.startsWith('https://')) {
				messageText += '\n\nНажмите кнопку ниже, чтобы создать свой тир-лист:'
				const inlineKeyboard = [
					[
						{
							text: '🎯 Открыть Тир Лист',
							web_app: { url: config.webApp.url },
						},
					],
				]
				markup = { reply_markup: { inline_keyboard: inlineKeyboard } }
			} else {
				// В режиме разработки показываем текстовую ссылку
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

							// Создаем инлайн кнопку для запуска бота
							const inlineKeyboard = []

							// Добавляем кнопку запуска бота, если URL доступен
							if (config.webApp.url.startsWith('https://')) {
								inlineKeyboard.push([
									{
										text: '🎯 Создать свой тир-лист',
										web_app: { url: config.webApp.url },
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

			// Создаем инлайн кнопку для запуска бота
			const inlineKeyboard = []

			// Добавляем кнопку запуска бота, если URL доступен
			if (config.webApp.url.startsWith('https://')) {
				inlineKeyboard.push([
					{
						text: '🎯 Создать свой тир-лист',
						web_app: { url: config.webApp.url },
					},
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
