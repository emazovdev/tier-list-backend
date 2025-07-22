import { Request, Response } from 'express';
import {
	imageGenerationService,
	ShareImageData,
} from '../services/imageGeneration.service';
import { TelegramBotService } from '../bot/telegramBot';
import { simpleBotMessagingService } from '../services/simpleBotMessaging.service';
import { initDataUtils } from '../utils/initDataUtils';
import { config } from '../config/env';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { testBufferConversion, diagnoseBuffer } from '../utils/bufferTest';
import { AnalyticsService, EventType } from '../services/analytics.service';

/**
 * Контроллер для обработки функций шаринга
 * ИСПРАВЛЕНИЕ: Использует глобальный экземпляр бота вместо создания нового
 */
export class ShareController {
	private botService: TelegramBotService;

	constructor(botService: TelegramBotService) {
		this.botService = botService;
	}

	/**
	 * Генерирует изображение результатов и отправляет в Telegram
	 */
	public shareResults = async (req: Request, res: Response) => {
		let userId: number | undefined; // Определяем в начале для доступа в catch

		try {
			const { shareData, telegramUser } = req.body; // telegramUser из middleware

			// Диагностика запроса (только в development)
			logger.debug(
				`ShareResults запрос: user ${telegramUser?.id}`,
				'IMAGE_GENERATION',
			);

			if (!shareData) {
				res.status(400).json({
					error: 'Отсутствуют данные для генерации изображения',
				});
				return;
			}

			if (!telegramUser || !telegramUser.id) {
				logger.error('Пользователь не найден в middleware', 'AUTH');

				res.status(400).json({
					error: 'Не удалось получить ID пользователя',
				});
				return;
			}

			userId = telegramUser.id;

			// Подготавливаем данные для генерации изображения
			const imageData: ShareImageData = {
				categorizedPlayerIds: shareData.categorizedPlayerIds,
				categories: shareData.categories,
				clubId: shareData.clubId,
			};

			// Генерируем изображение с оптимальными настройками
			const { imageBuffer, club } =
				await imageGenerationService.generateResultsImage(imageData, {
					quality: 90, // Высокое качество как для iOS
					width: 550, // Оптимальная ширина для аватарок
					height: 800, // Оптимальная высота
					optimizeForSpeed: false, // ВАЖНО: отключаем оптимизацию для загрузки аватарок
				});

			// Проверяем размер изображения
			const imageSizeMB = imageBuffer.length / (1024 * 1024);

			// Дополнительная валидация сгенерированного изображения
			if (!imageBuffer || imageBuffer.length === 0) {
				logger.error(
					'Генерация изображения вернула пустой Buffer',
					'IMAGE_GENERATION',
				);
				throw new Error('Не удалось сгенерировать изображение');
			}

			// Проверяем JPEG заголовок
			const jpegHeader = imageBuffer.subarray(0, 3);
			const isValidJPEG =
				jpegHeader[0] === 0xff &&
				jpegHeader[1] === 0xd8 &&
				jpegHeader[2] === 0xff;

			if (!isValidJPEG) {
				logger.error(
					`Сгенерированное изображение имеет неверный JPEG заголовок: ${jpegHeader.toString(
						'hex',
					)}`,
					'IMAGE_GENERATION',
				);
				throw new Error('Сгенерированное изображение повреждено');
			}

			logger.info(
				`✅ Изображение успешно сгенерировано: ${imageSizeMB.toFixed(
					2,
				)}MB, валидный JPEG, для клуба "${club.name}"`,
				'IMAGE_GENERATION',
			);

			if (imageSizeMB > 10) {
				logger.warn(
					`Изображение слишком большое: ${imageSizeMB.toFixed(2)}MB`,
					'IMAGE_GENERATION',
				);
			}

			// Отправляем изображение пользователю в Telegram
			const caption = `🏆 ТИР-ЛИСТ "${club.name.toUpperCase()}"\n\n⚽ Создай свой и делись с друзьями в @${
				config.telegram.botUsername
			}`;

			try {
				// Проверяем что userId определен
				if (!userId) {
					throw new Error('ID пользователя не определен');
				}

				// Дополнительная диагностика Buffer перед отправкой
				logger.info(
					`🔍 Диагностика Buffer перед отправкой: существует=${!!imageBuffer}, размер=${
						imageBuffer?.length || 0
					}, тип=${typeof imageBuffer}`,
					'IMAGE_GENERATION',
				);

				// Детальная диагностика Buffer
				logger.info(`🔬 Детальная диагностика Buffer:`, 'IMAGE_GENERATION');
				logger.info(`  - Существует: ${!!imageBuffer}`, 'IMAGE_GENERATION');
				logger.info(`  - Тип: ${typeof imageBuffer}`, 'IMAGE_GENERATION');
				logger.info(
					`  - Конструктор: ${imageBuffer?.constructor?.name || 'undefined'}`,
					'IMAGE_GENERATION',
				);
				logger.info(
					`  - Длина: ${imageBuffer?.length || 'undefined'}`,
					'IMAGE_GENERATION',
				);
				logger.info(
					`  - Buffer.isBuffer: ${Buffer.isBuffer(imageBuffer)}`,
					'IMAGE_GENERATION',
				);
				logger.info(
					`  - instanceof Buffer: ${imageBuffer instanceof Buffer}`,
					'IMAGE_GENERATION',
				);
				logger.info(
					`  - toString метод: ${typeof imageBuffer?.toString}`,
					'IMAGE_GENERATION',
				);
				logger.info(
					`  - subarray метод: ${typeof imageBuffer?.subarray}`,
					'IMAGE_GENERATION',
				);

				// Проверяем что Buffer всё ещё валидный
				let validImageBuffer: Buffer;
				if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
					// Попробуем восстановить Buffer если это возможно
					if (
						imageBuffer &&
						typeof imageBuffer === 'object' &&
						'length' in imageBuffer &&
						'subarray' in imageBuffer &&
						typeof (imageBuffer as any).length === 'number' &&
						typeof (imageBuffer as any).subarray === 'function'
					) {
						logger.info(
							`🔧 Попытка восстановления Buffer из объекта с данными`,
							'IMAGE_GENERATION',
						);

						try {
							// Попробуем создать новый Buffer из существующих данных
							const restoredBuffer = Buffer.from(imageBuffer as any);

							if (
								Buffer.isBuffer(restoredBuffer) &&
								restoredBuffer.length > 0
							) {
								logger.info(
									`✅ Buffer успешно восстановлен: размер=${restoredBuffer.length}`,
									'IMAGE_GENERATION',
								);
								validImageBuffer = restoredBuffer;
							} else {
								throw new Error('Восстановленный Buffer пустой или невалидный');
							}
						} catch (restoreError) {
							logger.error(
								`❌ Не удалось восстановить Buffer`,
								'IMAGE_GENERATION',
								restoreError as Error,
							);
							throw new Error('Buffer изображения поврежден перед отправкой');
						}
					} else {
						logger.error(
							`❌ Buffer стал невалидным перед отправкой: существует=${!!imageBuffer}, тип=${typeof imageBuffer}`,
							'IMAGE_GENERATION',
						);
						throw new Error('Buffer изображения поврежден перед отправкой');
					}
				} else {
					validImageBuffer = imageBuffer;
				}

				// Еще раз проверяем JPEG заголовок
				const headerCheck = validImageBuffer.subarray(0, 3);
				const stillValidJPEG =
					headerCheck[0] === 0xff &&
					headerCheck[1] === 0xd8 &&
					headerCheck[2] === 0xff;

				if (!stillValidJPEG) {
					logger.error(
						`❌ JPEG заголовок поврежден перед отправкой: ${headerCheck.toString(
							'hex',
						)}`,
						'IMAGE_GENERATION',
					);
					throw new Error('Изображение повреждено перед отправкой');
				}

				logger.info(
					`✅ Buffer валиден перед отправкой: ${imageSizeMB.toFixed(
						2,
					)}MB, JPEG OK`,
					'IMAGE_GENERATION',
				);

				// Дополнительный тест конвертации перед отправкой
				const conversionTest = testBufferConversion(
					validImageBuffer,
					'финальное изображение',
				);
				if (!conversionTest) {
					logger.error(
						'❌ Тест конвертации провален перед отправкой',
						'IMAGE_GENERATION',
					);
					throw new Error('Изображение повреждено и не может быть отправлено');
				}

				// Используем универсальный сервис отправки (работает в любом процессе)
				const success = await simpleBotMessagingService.sendImage(
					userId,
					validImageBuffer,
					caption,
				);

				if (!success) {
					throw new Error('Не удалось отправить изображение');
				}

				// Логируем успешную отправку
				logger.imageSent(true, userId.toString(), validImageBuffer.length);

				// Логируем событие поделиться картинкой в аналитику
				await AnalyticsService.logEvent(
					userId.toString(),
					EventType.IMAGE_SHARED,
					{
						clubName: club.name,
						imageSize: validImageBuffer.length,
					},
				);
			} catch (sendError) {
				// Логируем ошибку отправки
				logger.imageSent(false, userId?.toString());
				logger.error(
					'Ошибка отправки изображения',
					'TELEGRAM_BOT',
					sendError as Error,
				);

				// Если отправка не удалась, уведомляем пользователя
				throw new Error('Сервис временно недоступен. Попробуйте позже.');
			}

			// Закрываем веб-приложение
			res.json({
				success: true,
				message: 'Изображение успешно отправлено в чат',
				closeWebApp: true,
			});
		} catch (error) {
			logger.error(
				'Критическая ошибка при генерации и отправке изображения',
				'IMAGE_GENERATION',
				error as Error,
			);
			res.status(500).json({
				error: 'Произошла ошибка при обработке запроса',
			});
		}
	};

	/**
	 * Предварительный просмотр изображения (сжатое)
	 */
	public previewImage = async (req: Request, res: Response) => {
		try {
			const { categorizedPlayerIds, categories, clubId } = req.body;

			if (!categorizedPlayerIds || !categories || !clubId) {
				res.status(400).json({
					error: 'Отсутствуют обязательные параметры',
				});
				return;
			}

			const { imageBuffer } = await imageGenerationService.generateResultsImage(
				{
					categorizedPlayerIds,
					categories,
					clubId,
				},
				{ quality: 75, width: 550, height: 800 }, // Сжатое качество для превью
			);

			res.set({
				'Content-Type': 'image/jpeg',
				'Content-Length': imageBuffer.length.toString(),
				'Cache-Control': 'no-cache',
			});

			res.send(imageBuffer);
		} catch (error) {
			logger.error(
				'Ошибка при генерации превью изображения',
				'IMAGE_GENERATION',
				error as Error,
			);
			res.status(500).json({
				error: 'Не удалось сгенерировать изображение',
			});
		}
	};

	/**
	 * Изображение в высоком качестве для скачивания/шэринга
	 */
	public downloadImage = async (req: Request, res: Response) => {
		try {
			const { categorizedPlayerIds, categories, clubId } = req.body;

			if (!categorizedPlayerIds || !categories || !clubId) {
				res.status(400).json({
					error: 'Отсутствуют обязательные параметры',
				});
				return;
			}

			const { imageBuffer, club } =
				await imageGenerationService.generateResultsImage(
					{
						categorizedPlayerIds,
						categories,
						clubId,
					},
					{
						quality: 90, // Еще выше качество для аватарок
						width: 550, // Оптимальная ширина для аватарок
						height: 800, // Оптимальная высота
						optimizeForSpeed: false, // Отключаем оптимизацию для лучшего качества
					},
				);

			// ИСПРАВЛЕНИЕ: Формируем безопасное ASCII имя файла для HTTP заголовка
			const safeClubName = club.name
				.replace(/[а-яё]/gi, (char) => {
					// Транслитерация русских букв
					const map: { [key: string]: string } = {
						а: 'a',
						б: 'b',
						в: 'v',
						г: 'g',
						д: 'd',
						е: 'e',
						ё: 'e',
						ж: 'zh',
						з: 'z',
						и: 'i',
						й: 'y',
						к: 'k',
						л: 'l',
						м: 'm',
						н: 'n',
						о: 'o',
						п: 'p',
						р: 'r',
						с: 's',
						т: 't',
						у: 'u',
						ф: 'f',
						х: 'h',
						ц: 'c',
						ч: 'ch',
						ш: 'sh',
						щ: 'sch',
						ъ: '',
						ы: 'y',
						ь: '',
						э: 'e',
						ю: 'yu',
						я: 'ya',
					};
					return map[char.toLowerCase()] || char;
				})
				.replace(/[^a-zA-Z0-9\s]/g, '') // Оставляем только ASCII символы и пробелы
				.replace(/\s+/g, '-') // Заменяем пробелы на дефисы
				.toLowerCase()
				.substring(0, 30); // Ограничиваем длину

			const fileName = `tier-list-${safeClubName || 'club'}.jpg`;

			res.set({
				'Content-Type': 'image/jpeg',
				'Content-Length': imageBuffer.length.toString(),
				'Content-Disposition': `attachment; filename="${fileName}"`,
				'Cache-Control': 'private, max-age=3600', // Кэшируем на час
			});

			res.send(imageBuffer);
		} catch (error) {
			logger.error(
				'Ошибка при генерации изображения для скачивания:',
				error instanceof Error ? error.message : String(error),
			);
			res.status(500).json({
				error: 'Не удалось сгенерировать изображение',
			});
		}
	};
}

// ShareController будет создан в index.ts с передачей botService
