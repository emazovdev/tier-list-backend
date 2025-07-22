import puppeteer, { Browser, Page } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface BrowserInstance {
	browser: Browser;
	pages: Map<string, Page>;
	activePages: number;
	createdAt: number;
	lastUsed: number;
	processingTasks: number;
}

interface PageTaskOptions {
	html: string;
	viewportWidth: number;
	viewportHeight: number;
	quality: number;
	optimizeForSpeed: boolean;
}

/**
 * Пул браузеров Puppeteer для высоких нагрузок
 * Оптимизирован для 500+ одновременных сессий
 */
export class PuppeteerPoolService extends EventEmitter {
	private static instance: PuppeteerPoolService;
	private browserPool: Map<string, BrowserInstance> = new Map();
	private availableBrowsers: string[] = [];
	private processingQueue: Array<{
		id: string;
		options: PageTaskOptions;
		resolve: (buffer: Buffer) => void;
		reject: (error: Error) => void;
		createdAt: number;
	}> = [];

	// Настройки пула для высоких нагрузок
	private readonly POOL_SIZE = 8; // Оптимальное количество браузеров
	private readonly MAX_PAGES_PER_BROWSER = 10; // Максимум страниц на браузер
	private readonly BROWSER_TIMEOUT = 30 * 60 * 1000; // 30 минут жизни браузера
	private readonly PAGE_TIMEOUT = 2 * 60 * 1000; // 2 минуты жизни страницы
	private readonly QUEUE_TIMEOUT = 60 * 1000; // 1 минута таймаут задач
	private readonly BROWSER_RESTART_THRESHOLD = 100; // Перезапуск после 100 задач

	// Метрики
	private metrics = {
		totalTasksProcessed: 0,
		activeTasks: 0,
		browsersCreated: 0,
		browsersDestroyed: 0,
		averageTaskTime: 0,
		peakConcurrency: 0,
	};

	private isInitialized = false;
	private shutdownInProgress = false;
	private cleanupInterval: NodeJS.Timeout | null = null;

	private constructor() {
		super();
		this.setMaxListeners(1000);
	}

	public static getInstance(): PuppeteerPoolService {
		if (!PuppeteerPoolService.instance) {
			PuppeteerPoolService.instance = new PuppeteerPoolService();
		}
		return PuppeteerPoolService.instance;
	}

	/**
	 * Инициализация пула браузеров
	 */
	public async initialize(): Promise<void> {
		if (this.isInitialized) return;

		logger.info(
			`🚀 Инициализация пула браузеров: ${this.POOL_SIZE} экземпляров`,
			'PUPPETEER_POOL',
		);

		// Создаем базовые браузеры
		for (let i = 0; i < Math.min(3, this.POOL_SIZE); i++) {
			try {
				await this.createBrowser();
			} catch (error) {
				logger.error(
					`❌ Ошибка создания браузера ${i}:`,
					'PUPPETEER_POOL',
					error,
				);
			}
		}

		// Запускаем мониторинг и очистку
		this.startCleanupTask();
		this.startQueueProcessor();

		this.isInitialized = true;
		logger.info('✅ Пул браузеров инициализирован', 'PUPPETEER_POOL');
	}

	/**
	 * Создание нового браузера с оптимальными настройками
	 */
	private async createBrowser(): Promise<string> {
		const browserId = `browser_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}`;

		const isProduction = process.env.NODE_ENV === 'production';

		// Оптимизированные аргументы для высоких нагрузок
		const baseArgs = [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--disable-extensions',
			'--disable-plugins',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			'--no-first-run',
			'--no-zygote',
			'--single-process',
			'--disable-features=TranslateUI,VizDisplayCompositor',
			'--disable-ipc-flooding-protection',
			'--max-old-space-size=512', // Ограничиваем память на процесс
			'--memory-reducer',
			'--disable-background-networking',
			'--disable-client-side-phishing-detection',
			'--disable-component-update',
			'--disable-default-apps',
			'--disable-domain-reliability',
			'--disable-features=AudioServiceOutOfProcess',
			'--disable-hang-monitor',
			'--disable-notifications',
			'--disable-print-preview',
			'--disable-sync',
			'--hide-scrollbars',
			'--mute-audio',
			'--no-default-browser-check',
			'--no-pings',
			'--password-store=basic',
			'--use-mock-keychain',
		];

		let browser: Browser;

		try {
			if (isProduction) {
				browser = await puppeteer.launch({
					args: [...chromium.args, ...baseArgs],
					defaultViewport: chromium.defaultViewport,
					executablePath: await chromium.executablePath(),
					headless: chromium.headless,
					timeout: 30000,
				});
			} else {
				browser = await puppeteer.launch({
					headless: true,
					args: baseArgs,
					timeout: 30000,
				});
			}

			const browserInstance: BrowserInstance = {
				browser,
				pages: new Map(),
				activePages: 0,
				createdAt: Date.now(),
				lastUsed: Date.now(),
				processingTasks: 0,
			};

			this.browserPool.set(browserId, browserInstance);
			this.availableBrowsers.push(browserId);
			this.metrics.browsersCreated++;

			logger.info(`✅ Браузер ${browserId} создан`, 'PUPPETEER_POOL');

			// Отслеживаем события браузера
			browser.on('disconnected', () => {
				this.handleBrowserDisconnect(browserId);
			});

			return browserId;
		} catch (error) {
			logger.error(
				`❌ Ошибка создания браузера ${browserId}:`,
				'PUPPETEER_POOL',
				error,
			);
			throw error;
		}
	}

	/**
	 * Основной метод генерации изображения
	 */
	public async generateImage(options: PageTaskOptions): Promise<Buffer> {
		if (this.shutdownInProgress) {
			throw new Error('Сервис находится в процессе завершения работы');
		}

		const taskId = `task_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}`;

		return new Promise((resolve, reject) => {
			// Добавляем в очередь
			this.processingQueue.push({
				id: taskId,
				options,
				resolve,
				reject,
				createdAt: Date.now(),
			});

			// Устанавливаем таймаут
			setTimeout(() => {
				const queueIndex = this.processingQueue.findIndex(
					(task) => task.id === taskId,
				);
				if (queueIndex !== -1) {
					this.processingQueue.splice(queueIndex, 1);
					reject(new Error('Таймаут генерации изображения'));
				}
			}, this.QUEUE_TIMEOUT);

			// Пытаемся обработать немедленно
			this.processQueue();
		});
	}

	/**
	 * Обработчик очереди задач
	 */
	private async processQueue(): Promise<void> {
		if (this.processingQueue.length === 0) return;

		// Находим доступный браузер
		const browserId = await this.getAvailableBrowser();
		if (!browserId) return;

		const task = this.processingQueue.shift();
		if (!task) return;

		try {
			this.metrics.activeTasks++;
			this.metrics.peakConcurrency = Math.max(
				this.metrics.peakConcurrency,
				this.metrics.activeTasks,
			);

			const startTime = Date.now();
			const result = await this.executeTask(browserId, task.options);
			const duration = Date.now() - startTime;

			// Обновляем метрики
			this.metrics.totalTasksProcessed++;
			this.metrics.averageTaskTime =
				(this.metrics.averageTaskTime * (this.metrics.totalTasksProcessed - 1) +
					duration) /
				this.metrics.totalTasksProcessed;

			task.resolve(result);

			logger.info(
				`✅ Задача ${task.id} выполнена за ${duration}мс`,
				'PUPPETEER_POOL',
			);
		} catch (error) {
			task.reject(error as Error);
			logger.error(`❌ Ошибка задачи ${task.id}:`, 'PUPPETEER_POOL', error);
		} finally {
			this.metrics.activeTasks--;
			// Продолжаем обработку очереди
			setImmediate(() => this.processQueue());
		}
	}

	/**
	 * Получение доступного браузера
	 */
	private async getAvailableBrowser(): Promise<string | null> {
		// Проверяем существующие браузеры
		for (const browserId of this.availableBrowsers) {
			const browserInstance = this.browserPool.get(browserId);
			if (
				browserInstance &&
				browserInstance.activePages < this.MAX_PAGES_PER_BROWSER
			) {
				return browserId;
			}
		}

		// Создаем новый браузер если пул не заполнен
		if (this.browserPool.size < this.POOL_SIZE) {
			try {
				return await this.createBrowser();
			} catch (error) {
				logger.error(
					'❌ Не удалось создать новый браузер:',
					'PUPPETEER_POOL',
					error,
				);
			}
		}

		// Ждем освобождения браузера
		return null;
	}

	/**
	 * Выполнение задачи генерации
	 */
	private async executeTask(
		browserId: string,
		options: PageTaskOptions,
	): Promise<Buffer> {
		const browserInstance = this.browserPool.get(browserId);
		if (!browserInstance) {
			throw new Error('Браузер недоступен');
		}

		const pageId = `page_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}`;
		let page: Page | null = null;

		try {
			browserInstance.activePages++;
			browserInstance.processingTasks++;
			browserInstance.lastUsed = Date.now();

			// Создаем новую страницу
			page = await browserInstance.browser.newPage();
			browserInstance.pages.set(pageId, page);

			// Настраиваем страницу для оптимизации
			if (options.optimizeForSpeed) {
				await page.setRequestInterception(true);
				page.on('request', (req: any) => {
					const resourceType = req.resourceType();
					const url = req.url();

					if (
						resourceType === 'stylesheet' ||
						resourceType === 'font' ||
						resourceType === 'script'
					) {
						if (url.startsWith('http') && !url.startsWith('data:')) {
							req.abort();
							return;
						}
					}

					if (resourceType === 'image') {
						req.continue();
						return;
					}

					req.continue();
				});

				await page.setJavaScriptEnabled(false);
			}

			// Устанавливаем viewport
			const devicePixelRatio =
				options.quality >= 95 ? 2.5 : options.quality >= 90 ? 2 : 1.5;
			await page.setViewport({
				width: options.viewportWidth,
				height: options.viewportHeight,
				deviceScaleFactor: devicePixelRatio,
			});

			// Загружаем контент
			await page.setContent(options.html, {
				waitUntil: options.optimizeForSpeed
					? 'domcontentloaded'
					: 'networkidle0',
				timeout: 15000,
			});

			if (!options.optimizeForSpeed) {
				await page.evaluateHandle('document.fonts.ready');
			}

			// Создаем скриншот
			const screenshot = await page.screenshot({
				type: 'jpeg',
				quality: Math.max(85, Math.min(100, options.quality)),
				optimizeForSpeed: false,
				clip: {
					x: 0,
					y: 0,
					width: options.viewportWidth,
					height: options.viewportHeight,
				},
			});

			// Валидация
			if (!screenshot || screenshot.length === 0) {
				throw new Error('Пустой скриншот');
			}

			const jpegHeader = screenshot.subarray(0, 3);
			const isValidJPEG =
				jpegHeader[0] === 0xff &&
				jpegHeader[1] === 0xd8 &&
				jpegHeader[2] === 0xff;

			if (!isValidJPEG) {
				throw new Error('Невалидный JPEG файл');
			}

			return screenshot;
		} finally {
			// Очищаем ресурсы
			if (page) {
				try {
					await page.close();
					browserInstance.pages.delete(pageId);
				} catch (error) {
					logger.error('❌ Ошибка закрытия страницы:', 'PUPPETEER_POOL', error);
				}
			}

			browserInstance.activePages--;
			browserInstance.processingTasks--;

			// Проверяем нужно ли перезапустить браузер
			if (browserInstance.processingTasks >= this.BROWSER_RESTART_THRESHOLD) {
				setImmediate(() => this.destroyBrowser(browserId));
			}
		}
	}

	/**
	 * Уничтожение браузера
	 */
	private async destroyBrowser(browserId: string): Promise<void> {
		const browserInstance = this.browserPool.get(browserId);
		if (!browserInstance) return;

		try {
			// Закрываем все страницы
			for (const [pageId, page] of browserInstance.pages) {
				try {
					await page.close();
				} catch (error) {
					logger.error(
						`❌ Ошибка закрытия страницы ${pageId}:`,
						'PUPPETEER_POOL',
						error,
					);
				}
			}

			// Закрываем браузер
			await browserInstance.browser.close();

			// Удаляем из пула
			this.browserPool.delete(browserId);
			const index = this.availableBrowsers.indexOf(browserId);
			if (index !== -1) {
				this.availableBrowsers.splice(index, 1);
			}

			this.metrics.browsersDestroyed++;
			logger.info(`🗑️ Браузер ${browserId} уничтожен`, 'PUPPETEER_POOL');
		} catch (error) {
			logger.error(
				`❌ Ошибка уничтожения браузера ${browserId}:`,
				'PUPPETEER_POOL',
				error,
			);
		}
	}

	/**
	 * Обработчик отключения браузера
	 */
	private handleBrowserDisconnect(browserId: string): void {
		logger.warn(`⚠️ Браузер ${browserId} отключился`, 'PUPPETEER_POOL');
		this.destroyBrowser(browserId);
	}

	/**
	 * Задача очистки устаревших ресурсов
	 */
	private startCleanupTask(): void {
		this.cleanupInterval = setInterval(() => {
			const now = Date.now();

			for (const [browserId, browserInstance] of this.browserPool) {
				// Закрываем старые браузеры
				if (now - browserInstance.createdAt > this.BROWSER_TIMEOUT) {
					logger.info(
						`🧹 Закрытие устаревшего браузера ${browserId}`,
						'PUPPETEER_POOL',
					);
					this.destroyBrowser(browserId);
					continue;
				}

				// Закрываем старые страницы
				for (const [pageId, page] of browserInstance.pages) {
					if (browserInstance.activePages === 0) {
						page.close().catch(() => {});
						browserInstance.pages.delete(pageId);
					}
				}
			}

			// Удаляем старые задачи из очереди
			this.processingQueue = this.processingQueue.filter((task) => {
				if (now - task.createdAt > this.QUEUE_TIMEOUT) {
					task.reject(new Error('Таймаут очереди'));
					return false;
				}
				return true;
			});
		}, 30000); // Каждые 30 секунд
	}

	/**
	 * Запуск обработчика очереди
	 */
	private startQueueProcessor(): void {
		setInterval(() => {
			if (this.processingQueue.length > 0) {
				this.processQueue();
			}
		}, 100); // Каждые 100мс
	}

	/**
	 * Получение метрик
	 */
	public getMetrics() {
		return {
			...this.metrics,
			totalBrowsers: this.browserPool.size,
			availableBrowsers: this.availableBrowsers.length,
			queueSize: this.processingQueue.length,
			totalPages: Array.from(this.browserPool.values()).reduce(
				(sum, b) => sum + b.pages.size,
				0,
			),
		};
	}

	/**
	 * Graceful shutdown
	 */
	public async shutdown(): Promise<void> {
		this.shutdownInProgress = true;
		logger.info(
			'🔄 Завершение работы PuppeteerPoolService...',
			'PUPPETEER_POOL',
		);

		// Останавливаем задачи очистки
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		// Отклоняем все ожидающие задачи
		for (const task of this.processingQueue) {
			task.reject(new Error('Сервис завершает работу'));
		}
		this.processingQueue = [];

		// Закрываем все браузеры
		const destroyPromises = Array.from(this.browserPool.keys()).map(
			(browserId) => this.destroyBrowser(browserId),
		);

		await Promise.all(destroyPromises);

		logger.info('✅ PuppeteerPoolService завершен', 'PUPPETEER_POOL');
	}
}

export const puppeteerPoolService = PuppeteerPoolService.getInstance();
