import { redisService } from './redis.service';
import { logger } from '../utils/logger';
import { testBufferConversion, diagnoseBuffer } from '../utils/bufferTest';

interface ImageTask {
	id: string;
	chatId: number;
	imageBuffer: string; // base64
	caption: string;
	timestamp: number;
}

/**
 * Простой сервис для отправки изображений через Redis
 * Избегает проблем с IPC в PM2 cluster mode
 */
export class SimpleBotMessagingService {
	private static instance: SimpleBotMessagingService;
	private botService: any = null;
	private isProcessingTasks = false;
	private taskProcessorInterval: NodeJS.Timeout | null = null;

	private constructor() {
		this.startTaskProcessor();
	}

	public static getInstance(): SimpleBotMessagingService {
		if (!SimpleBotMessagingService.instance) {
			SimpleBotMessagingService.instance = new SimpleBotMessagingService();
		}
		return SimpleBotMessagingService.instance;
	}

	/**
	 * Устанавливает ссылку на bot service (только в master процессе)
	 */
	public setBotService(botService: any) {
		this.botService = botService;
	}

	/**
	 * Запускает обработчик задач в master процессе
	 */
	private startTaskProcessor() {
		const isMasterProcess = process.env.pm_id === '0';

		if (isMasterProcess && !this.isProcessingTasks) {
			this.isProcessingTasks = true;

			// Используем setInterval вместо рекурсивных setTimeout для избежания переполнения стека
			this.taskProcessorInterval = setInterval(async () => {
				if (this.isProcessingTasks) {
					await this.processImageTasks();
				}
			}, 100);
		}
	}

	/**
	 * Обрабатывает задачи отправки изображений (только в master процессе)
	 */
	private async processImageTasks() {
		const isMasterProcess = process.env.pm_id === '0';

		if (!isMasterProcess || !this.isProcessingTasks) return;

		try {
			// Получаем задачу из Redis очереди (неблокирующий вызов)
			const taskData = await redisService.getClient().lpop('image_send_queue');

			if (taskData) {
				const task: ImageTask = JSON.parse(taskData);
				await this.handleImageTask(task);
			}
		} catch (error) {
			logger.error(
				'Ошибка обработки задач изображений',
				'TELEGRAM_BOT',
				error as Error,
			);
		}
	}

	/**
	 * Обрабатывает одну задачу отправки изображения
	 */
	private async handleImageTask(task: ImageTask) {
		let success = false;
		let errorMessage = '';

		try {
			if (!this.botService?.isBotAvailable()) {
				errorMessage = 'Bot service недоступен при обработке задачи';
				logger.error(errorMessage, 'TELEGRAM_BOT');
				return;
			}

			// Конвертируем base64 обратно в Buffer с дополнительной валидацией
			let imageBuffer: Buffer;
			try {
				// Проверяем валидность base64 строки перед конвертацией
				if (!task.imageBuffer || typeof task.imageBuffer !== 'string') {
					throw new Error(
						'Base64 строка не определена или не является строкой',
					);
				}

				// Проверяем корректность base64 формата
				const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
				if (!base64Regex.test(task.imageBuffer)) {
					throw new Error('Некорректный формат base64 строки');
				}

				logger.info(
					`🔄 Конвертация base64 в Buffer: длина base64=${task.imageBuffer.length}`,
					'TELEGRAM_BOT',
				);

				imageBuffer = Buffer.from(task.imageBuffer, 'base64');

				// Дополнительная диагностика для отладки
				diagnoseBuffer(imageBuffer, 'конвертированный из base64');

				// Проверяем результат конвертации
				if (!Buffer.isBuffer(imageBuffer)) {
					throw new Error('Результат конвертации не является Buffer');
				}

				if (imageBuffer.length === 0) {
					throw new Error('Результат конвертации пустой');
				}

				// Проверяем целостность данных - конвертируем обратно в base64 и сравниваем
				const verificationBase64 = imageBuffer.toString('base64');
				if (verificationBase64 !== task.imageBuffer) {
					throw new Error(
						'Данные повреждены при конвертации - проверка целостности не пройдена',
					);
				}

				logger.info(
					`✅ Конвертация завершена: размер Buffer=${imageBuffer.length}, целостность данных подтверждена`,
					'TELEGRAM_BOT',
				);
			} catch (conversionError) {
				errorMessage = `Ошибка конвертации base64 в Buffer: ${
					(conversionError as Error).message
				}`;
				logger.error(errorMessage, 'TELEGRAM_BOT', conversionError as Error);
				return;
			}

			// Валидируем Buffer после конвертации
			if (!this.validateImageBuffer(imageBuffer)) {
				errorMessage = 'Buffer невалиден после конвертации из base64';
				logger.error(errorMessage, 'TELEGRAM_BOT');
				return;
			}

			const imageSizeMB = imageBuffer.length / (1024 * 1024);

			logger.info(
				`🎯 Обработка задачи отправки изображения: ${imageSizeMB.toFixed(
					2,
				)}MB для пользователя ${task.chatId}`,
				'TELEGRAM_BOT',
			);

			// Отправляем изображение (TelegramBotService сам обработает повторные попытки)
			success = await this.botService.sendImage(
				task.chatId,
				imageBuffer,
				task.caption,
			);

			logger.imageSent(success, task.chatId.toString(), imageBuffer.length);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				'Ошибка отправки изображения в задаче',
				'TELEGRAM_BOT',
				error as Error,
			);
			logger.imageSent(false, task.chatId.toString());
		} finally {
			// Сохраняем результат в Redis для worker процесса
			try {
				await redisService.getClient().setex(
					`image_result:${task.id}`,
					60, // Увеличиваем TTL до 60 секунд
					JSON.stringify({
						success,
						timestamp: Date.now(),
						error: errorMessage || undefined,
					}),
				);
			} catch (redisError) {
				logger.error(
					'Ошибка сохранения результата в Redis',
					'TELEGRAM_BOT',
					redisError as Error,
				);
			}
		}
	}

	/**
	 * Отправка изображения (универсальный метод)
	 */
	public async sendImage(
		chatId: number,
		imageBuffer: Buffer,
		caption: string,
	): Promise<boolean> {
		// Предварительная валидация Buffer
		if (!this.validateImageBuffer(imageBuffer)) {
			logger.error(
				'❌ Получен невалидный Buffer изображения в SimpleBotMessagingService',
				'TELEGRAM_BOT',
			);
			return false;
		}

		const isMasterProcess = process.env.pm_id === '0';

		// Если мы в master процессе - отправляем напрямую
		if (isMasterProcess && this.botService?.isBotAvailable()) {
			try {
				logger.info(
					`🎯 Прямая отправка в master процессе для пользователя ${chatId}`,
					'TELEGRAM_BOT',
				);

				const result = await this.botService.sendImage(
					chatId,
					imageBuffer,
					caption,
				);
				logger.imageSent(result, chatId.toString(), imageBuffer.length);
				return result;
			} catch (error) {
				logger.error(
					'❌ Ошибка прямой отправки в master процессе, попробуем через очередь',
					'TELEGRAM_BOT',
					error as Error,
				);
				// НЕ возвращаем false сразу, попробуем через очередь как fallback
			}
		}

		// Если мы в worker процессе - добавляем задачу в Redis очередь
		try {
			const taskId = `${Date.now()}-${Math.random()}`;

			// Дополнительная валидация Buffer перед конвертацией в base64
			logger.info(
				`🔄 Подготовка задачи: Buffer размер=${
					imageBuffer.length
				}, валидный=${Buffer.isBuffer(imageBuffer)}`,
				'TELEGRAM_BOT',
			);

			// Проверяем JPEG заголовок перед конвертацией
			const jpegHeader = imageBuffer.subarray(0, 3);
			const isValidJPEG =
				jpegHeader[0] === 0xff &&
				jpegHeader[1] === 0xd8 &&
				jpegHeader[2] === 0xff;

			if (!isValidJPEG) {
				logger.error(
					`❌ Buffer содержит поврежденный JPEG перед конвертацией в base64: ${jpegHeader.toString(
						'hex',
					)}`,
					'TELEGRAM_BOT',
				);
				return false;
			}

			// Конвертируем в base64 с проверкой
			let base64String: string;
			try {
				// Дополнительный тест конвертации для диагностики
				const conversionTest = testBufferConversion(
					imageBuffer,
					'исходное изображение',
				);
				if (!conversionTest) {
					logger.error(
						'❌ Тест конвертации Buffer → base64 → Buffer провален',
						'TELEGRAM_BOT',
					);
					return false;
				}

				base64String = imageBuffer.toString('base64');

				if (!base64String || base64String.length === 0) {
					throw new Error('Пустая base64 строка');
				}

				logger.info(
					`✅ Конвертация в base64 успешна: длина=${base64String.length}`,
					'TELEGRAM_BOT',
				);
			} catch (base64Error) {
				logger.error(
					'❌ Ошибка конвертации Buffer в base64',
					'TELEGRAM_BOT',
					base64Error as Error,
				);
				return false;
			}

			const task: ImageTask = {
				id: taskId,
				chatId,
				imageBuffer: base64String,
				caption,
				timestamp: Date.now(),
			};

			// Добавляем задачу в очередь
			await redisService
				.getClient()
				.rpush('image_send_queue', JSON.stringify(task));

			// Ждем результат (максимум 45 секунд - учитываем повторные попытки)
			for (let i = 0; i < 450; i++) {
				const result = await redisService
					.getClient()
					.get(`image_result:${taskId}`);
				if (result) {
					const parsed = JSON.parse(result);
					await redisService.getClient().del(`image_result:${taskId}`);
					logger.imageSent(
						parsed.success === true,
						chatId.toString(),
						imageBuffer.length,
					);
					return parsed.success === true;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			logger.error(
				'Таймаут ожидания результата отправки изображения',
				'TELEGRAM_BOT',
			);
			logger.imageSent(false, chatId.toString());
			return false;
		} catch (error) {
			logger.error(
				'Ошибка добавления задачи в очередь',
				'TELEGRAM_BOT',
				error as Error,
			);
			logger.imageSent(false, chatId.toString());
			return false;
		}
	}

	/**
	 * Валидирует Buffer изображения перед отправкой
	 */
	private validateImageBuffer(buffer: Buffer): boolean {
		try {
			logger.info(
				`🔍 Начало валидации Buffer: buffer=${!!buffer}, тип=${typeof buffer}`,
				'TELEGRAM_BOT',
			);

			// Проверяем что Buffer существует и не пустой
			if (!buffer) {
				logger.error('❌ Buffer не определен (null/undefined)', 'TELEGRAM_BOT');
				return false;
			}

			if (!Buffer.isBuffer(buffer)) {
				logger.error(
					`❌ Объект не является Buffer, тип: ${typeof buffer}${
						buffer
							? `, конструктор: ${
									(buffer as any).constructor?.name || 'unknown'
							  }`
							: ''
					}`,
					'TELEGRAM_BOT',
				);
				return false;
			}

			if (buffer.length === 0) {
				logger.error('❌ Buffer пустой (длина = 0)', 'TELEGRAM_BOT');
				return false;
			}

			logger.info(
				`✅ Buffer базовая валидация прошла: длина=${buffer.length}`,
				'TELEGRAM_BOT',
			);

			// Проверяем минимальный размер (1KB)
			if (buffer.length < 1024) {
				logger.error(
					`❌ Buffer слишком маленький: ${buffer.length} байт`,
					'TELEGRAM_BOT',
				);
				return false;
			}

			// Проверяем максимальный размер (20MB)
			const sizeMB = buffer.length / (1024 * 1024);
			if (sizeMB > 20) {
				logger.error(
					`❌ Buffer слишком большой: ${sizeMB.toFixed(2)}MB`,
					'TELEGRAM_BOT',
				);
				return false;
			}

			logger.info(
				`✅ Buffer размер валиден: ${sizeMB.toFixed(2)}MB`,
				'TELEGRAM_BOT',
			);

			// Проверяем JPEG заголовок
			const jpegHeader = buffer.subarray(0, 3);
			const isValidJPEG =
				jpegHeader[0] === 0xff &&
				jpegHeader[1] === 0xd8 &&
				jpegHeader[2] === 0xff;

			if (!isValidJPEG) {
				logger.error(
					`❌ Buffer не содержит JPEG заголовка: ${jpegHeader.toString('hex')}`,
					'TELEGRAM_BOT',
				);
				return false;
			}

			logger.info(
				`✅ Buffer изображения валиден: ${sizeMB.toFixed(
					2,
				)}MB, JPEG заголовок корректен`,
				'TELEGRAM_BOT',
			);

			return true;
		} catch (error) {
			logger.error(
				'❌ Ошибка при валидации Buffer:',
				'TELEGRAM_BOT',
				error as Error,
			);
			return false;
		}
	}

	/**
	 * Остановка обработки задач
	 */
	public stop() {
		this.isProcessingTasks = false;

		if (this.taskProcessorInterval) {
			clearInterval(this.taskProcessorInterval);
			this.taskProcessorInterval = null;
		}
	}
}

export const simpleBotMessagingService =
	SimpleBotMessagingService.getInstance();
