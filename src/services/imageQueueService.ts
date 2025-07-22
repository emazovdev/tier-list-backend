import { Worker } from 'worker_threads';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface ImageGenerationTask {
	id: string;
	html: string;
	width: number;
	height: number;
	quality: number;
	optimizeForSpeed: boolean;
	resolve: (buffer: Buffer) => void;
	reject: (error: Error) => void;
	createdAt: number;
}

interface WorkerInfo {
	worker: Worker;
	busy: boolean;
	currentTaskId?: string;
	tasksCompleted: number;
}

/**
 * Сервис очередей для генерации изображений с пулом воркеров
 * Оптимизирован для высоких нагрузок и стабильности
 */
export class ImageQueueService extends EventEmitter {
	private static instance: ImageQueueService;
	private workers: WorkerInfo[] = [];
	private taskQueue: ImageGenerationTask[] = [];
	private isInitialized = false;

	// Настройки для высоких нагрузок
	private readonly MAX_WORKERS = 4; // Ограничиваем количество воркеров
	private readonly MAX_QUEUE_SIZE = 100; // Максимальный размер очереди
	private readonly TASK_TIMEOUT = 30000; // 30 секунд на задачу
	private readonly WORKER_RESTART_THRESHOLD = 50; // Перезапуск воркера после 50 задач

	// Метрики производительности
	private metrics = {
		tasksCompleted: 0,
		tasksQueued: 0,
		tasksFailed: 0,
		averageExecutionTime: 0,
		queueWaitTime: 0,
	};

	private constructor() {
		super();
		this.setMaxListeners(200); // Увеличиваем лимит слушателей
	}

	public static getInstance(): ImageQueueService {
		if (!ImageQueueService.instance) {
			ImageQueueService.instance = new ImageQueueService();
		}
		return ImageQueueService.instance;
	}

	/**
	 * Инициализация пула воркеров
	 */
	public async initialize(): Promise<void> {
		if (this.isInitialized) return;

		logger.info(
			`🚀 Инициализация пула воркеров: ${this.MAX_WORKERS} воркеров`,
			'IMAGE_QUEUE',
		);

		// Создаем воркеры
		for (let i = 0; i < this.MAX_WORKERS; i++) {
			await this.createWorker(i);
		}

		// Запускаем мониторинг очереди
		this.startQueueMonitoring();

		this.isInitialized = true;
		logger.info('✅ Пул воркеров инициализирован', 'IMAGE_QUEUE');
	}

	/**
	 * Создание нового воркера
	 */
	private async createWorker(index: number): Promise<void> {
		try {
			const workerPath = path.join(__dirname, '../workers/imageWorker.js');
			const worker = new Worker(workerPath);

			const workerInfo: WorkerInfo = {
				worker,
				busy: false,
				tasksCompleted: 0,
			};

			// Обработка сообщений от воркера
			worker.on(
				'message',
				(result: {
					success: boolean;
					data?: Buffer;
					error?: string;
					taskId: string;
				}) => {
					this.handleWorkerMessage(workerInfo, result);
				},
			);

			// Обработка ошибок воркера
			worker.on('error', (error) => {
				logger.error(`❌ Ошибка воркера ${index}:`, 'IMAGE_QUEUE', error);
				this.handleWorkerError(workerInfo, error);
			});

			// Обработка завершения воркера
			worker.on('exit', (code) => {
				logger.warn(
					`🔄 Воркер ${index} завершен с кодом ${code}`,
					'IMAGE_QUEUE',
				);
				this.handleWorkerExit(workerInfo);
			});

			this.workers.push(workerInfo);
			logger.info(`✅ Воркер ${index} создан`, 'IMAGE_QUEUE');
		} catch (error) {
			logger.error(
				`❌ Ошибка создания воркера ${index}:`,
				'IMAGE_QUEUE',
				error,
			);
			throw error;
		}
	}

	/**
	 * Добавление задачи в очередь
	 */
	public async generateImage(
		html: string,
		width: number = 550,
		height: number = 800,
		quality: number = 85,
		optimizeForSpeed: boolean = true,
	): Promise<Buffer> {
		// Проверяем размер очереди
		if (this.taskQueue.length >= this.MAX_QUEUE_SIZE) {
			throw new Error(
				`Очередь переполнена. Максимальный размер: ${this.MAX_QUEUE_SIZE}`,
			);
		}

		return new Promise((resolve, reject) => {
			const taskId = `task_${Date.now()}_${Math.random()
				.toString(36)
				.substr(2, 9)}`;

			const task: ImageGenerationTask = {
				id: taskId,
				html,
				width,
				height,
				quality,
				optimizeForSpeed,
				resolve,
				reject,
				createdAt: Date.now(),
			};

			this.taskQueue.push(task);
			this.metrics.tasksQueued++;

			logger.info(
				`📋 Задача ${taskId} добавлена в очередь. Размер очереди: ${this.taskQueue.length}`,
				'IMAGE_QUEUE',
			);

			// Пытаемся немедленно обработать задачу
			this.processQueue();

			// Устанавливаем таймаут для задачи
			setTimeout(() => {
				const taskIndex = this.taskQueue.findIndex((t) => t.id === taskId);
				if (taskIndex !== -1) {
					this.taskQueue.splice(taskIndex, 1);
					this.metrics.tasksFailed++;
					reject(new Error('Таймаут генерации изображения'));
				}
			}, this.TASK_TIMEOUT);
		});
	}

	/**
	 * Обработка очереди
	 */
	private processQueue(): void {
		// Находим свободного воркера
		const freeWorker = this.workers.find((w) => !w.busy);

		if (!freeWorker || this.taskQueue.length === 0) {
			return;
		}

		const task = this.taskQueue.shift()!;
		freeWorker.busy = true;
		freeWorker.currentTaskId = task.id;

		// Отправляем задачу воркеру
		try {
			freeWorker.worker.postMessage({
				taskId: task.id,
				html: task.html,
				viewportWidth: task.width,
				viewportHeight: task.height,
				quality: task.quality,
				optimizeForSpeed: task.optimizeForSpeed,
			});

			logger.info(`🎯 Задача ${task.id} отправлена воркеру`, 'IMAGE_QUEUE');
		} catch (error) {
			this.handleTaskError(task, error as Error);
			freeWorker.busy = false;
			freeWorker.currentTaskId = undefined;
		}
	}

	/**
	 * Обработка сообщений от воркера
	 */
	private handleWorkerMessage(workerInfo: WorkerInfo, result: any): void {
		const task = this.findTaskById(result.taskId);

		if (!task) {
			logger.warn(
				`⚠️ Получен результат для неизвестной задачи: ${result.taskId}`,
				'IMAGE_QUEUE',
			);
			return;
		}

		workerInfo.busy = false;
		workerInfo.currentTaskId = undefined;
		workerInfo.tasksCompleted++;

		if (result.success && result.data) {
			const executionTime = Date.now() - task.createdAt;
			this.updateMetrics(executionTime);

			task.resolve(result.data);
			logger.info(
				`✅ Задача ${task.id} выполнена за ${executionTime}мс`,
				'IMAGE_QUEUE',
			);
		} else {
			this.metrics.tasksFailed++;
			task.reject(new Error(result.error || 'Неизвестная ошибка воркера'));
			logger.error(
				`❌ Задача ${task.id} завершилась с ошибкой: ${result.error}`,
				'IMAGE_QUEUE',
			);
		}

		// Проверяем, нужно ли перезапустить воркера
		if (workerInfo.tasksCompleted >= this.WORKER_RESTART_THRESHOLD) {
			this.restartWorker(workerInfo);
		}

		// Продолжаем обработку очереди
		this.processQueue();
	}

	/**
	 * Обработка ошибок воркера
	 */
	private handleWorkerError(workerInfo: WorkerInfo, error: Error): void {
		const task = this.findTaskById(workerInfo.currentTaskId);
		if (task) {
			this.handleTaskError(task, error);
		}

		workerInfo.busy = false;
		workerInfo.currentTaskId = undefined;

		// Перезапускаем воркера
		this.restartWorker(workerInfo);
	}

	/**
	 * Обработка завершения воркера
	 */
	private handleWorkerExit(workerInfo: WorkerInfo): void {
		const index = this.workers.indexOf(workerInfo);
		if (index !== -1) {
			this.workers.splice(index, 1);
			this.createWorker(index).catch((error) => {
				logger.error('Ошибка при пересоздании воркера:', 'IMAGE_QUEUE', error);
			});
		}
	}

	/**
	 * Перезапуск воркера
	 */
	private async restartWorker(workerInfo: WorkerInfo): Promise<void> {
		const index = this.workers.indexOf(workerInfo);

		try {
			await workerInfo.worker.terminate();
			this.workers.splice(index, 1);
			await this.createWorker(index);

			logger.info(`🔄 Воркер ${index} перезапущен`, 'IMAGE_QUEUE');
		} catch (error) {
			logger.error(
				`❌ Ошибка перезапуска воркера ${index}:`,
				'IMAGE_QUEUE',
				error,
			);
		}
	}

	/**
	 * Поиск задачи по ID
	 */
	private findTaskById(taskId?: string): ImageGenerationTask | undefined {
		return this.taskQueue.find((task) => task.id === taskId);
	}

	/**
	 * Обработка ошибки задачи
	 */
	private handleTaskError(task: ImageGenerationTask, error: Error): void {
		this.metrics.tasksFailed++;
		task.reject(error);
	}

	/**
	 * Обновление метрик
	 */
	private updateMetrics(executionTime: number): void {
		this.metrics.tasksCompleted++;
		this.metrics.averageExecutionTime =
			(this.metrics.averageExecutionTime * (this.metrics.tasksCompleted - 1) +
				executionTime) /
			this.metrics.tasksCompleted;
	}

	/**
	 * Мониторинг очереди
	 */
	private startQueueMonitoring(): void {
		setInterval(() => {
			const busyWorkers = this.workers.filter((w) => w.busy).length;
			const queueSize = this.taskQueue.length;

			if (queueSize > 0 || busyWorkers > 0) {
				logger.info(
					`📊 Очередь: ${queueSize} задач, Воркеры: ${busyWorkers}/${this.workers.length} заняты`,
					'IMAGE_QUEUE',
				);
			}

			// Предупреждение о переполнении очереди
			if (queueSize > this.MAX_QUEUE_SIZE * 0.8) {
				logger.warn(
					`⚠️ Очередь близка к переполнению: ${queueSize}/${this.MAX_QUEUE_SIZE}`,
					'IMAGE_QUEUE',
				);
			}
		}, 30000); // Каждые 30 секунд
	}

	/**
	 * Получение метрик
	 */
	public getMetrics() {
		return {
			...this.metrics,
			queueSize: this.taskQueue.length,
			activeWorkers: this.workers.length,
			busyWorkers: this.workers.filter((w) => w.busy).length,
		};
	}

	/**
	 * Graceful shutdown
	 */
	public async shutdown(): Promise<void> {
		logger.info('🔄 Завершение работы ImageQueueService...', 'IMAGE_QUEUE');

		// Завершаем всех воркеров
		await Promise.all(
			this.workers.map((workerInfo) =>
				workerInfo.worker
					.terminate()
					.catch((error) =>
						logger.error('Ошибка завершения воркера:', 'IMAGE_QUEUE', error),
					),
			),
		);

		this.workers = [];
		logger.info('✅ ImageQueueService завершен', 'IMAGE_QUEUE');
	}
}

export const imageQueueService = ImageQueueService.getInstance();
