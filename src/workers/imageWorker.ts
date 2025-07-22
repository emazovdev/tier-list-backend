import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

/**
 * Worker для генерации изображений без блокировки основного потока
 */

if (!isMainThread && parentPort) {
	// Код воркера
	parentPort.on(
		'message',
		async (data: {
			html: string;
			viewportWidth: number;
			viewportHeight: number;
			quality?: number;
			optimizeForSpeed?: boolean;
		}) => {
			try {
				const {
					html,
					viewportWidth,
					viewportHeight,
					quality = 85,
					optimizeForSpeed = true,
				} = data;

				// Определяем, используем ли мы serverless окружение
				const isProduction = process.env.NODE_ENV === 'production';

				// Настройки для оптимизации
				const baseArgs = [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-accelerated-2d-canvas',
					'--no-first-run',
					'--no-zygote',
					'--single-process',
					'--disable-gpu',
					'--disable-extensions',
					'--disable-plugins',
					'--disable-background-timer-throttling',
					'--disable-backgrounding-occluded-windows',
					'--disable-renderer-backgrounding',
					'--disable-features=TranslateUI',
					'--disable-ipc-flooding-protection',
				];

				// Дополнительные оптимизации для скорости
				if (optimizeForSpeed) {
					baseArgs.push(
						'--disable-features=VizDisplayCompositor',
						'--disable-background-networking',
						'--disable-background-timer-throttling',
						'--disable-client-side-phishing-detection',
						'--disable-component-update',
						'--disable-default-apps',
						'--disable-domain-reliability',
						'--disable-features=AudioServiceOutOfProcess',
						'--disable-hang-monitor',
						'--disable-notifications',
						'--disable-offer-store-unmasked-wallet-cards',
						'--disable-offer-upload-credit-cards',
						'--disable-print-preview',
						'--disable-prompt-on-repost',
						'--disable-speech-api',
						'--disable-sync',
						'--hide-scrollbars',
						'--ignore-gpu-blacklist',
						'--metrics-recording-only',
						'--mute-audio',
						'--no-default-browser-check',
						'--no-pings',
						'--password-store=basic',
						'--use-mock-keychain',
					);
				}

				let browser;
				if (isProduction) {
					// Для production (Railway/serverless) используем chromium
					browser = await puppeteer.launch({
						args: [...chromium.args, ...baseArgs],
						defaultViewport: chromium.defaultViewport,
						executablePath: await chromium.executablePath(),
						headless: chromium.headless,
						timeout: 30000,
					});
				} else {
					// Для локальной разработки
					try {
						browser = await puppeteer.launch({
							args: [...chromium.args, ...baseArgs],
							defaultViewport: chromium.defaultViewport,
							executablePath: await chromium.executablePath(),
							headless: chromium.headless,
							timeout: 30000,
						});
					} catch (error) {
						// Fallback на системный браузер
						browser = await puppeteer.launch({
							headless: true,
							args: baseArgs,
							timeout: 30000,
						});
					}
				}

				const page = await browser.newPage();

				try {
					// Оптимизируем производительность страницы
					if (optimizeForSpeed) {
						// Отключаем ненужные ресурсы, НО разрешаем изображения
						await page.setRequestInterception(true);
						page.on('request', (req: any) => {
							const resourceType = req.resourceType();
							const url = req.url();

							if (
								resourceType === 'stylesheet' ||
								resourceType === 'font' ||
								resourceType === 'script'
							) {
								// Пропускаем внешние ресурсы, используем только инлайн
								if (url.startsWith('http') && !url.startsWith('data:')) {
									req.abort();
									return;
								}
							}

							// Разрешаем изображения (включая внешние URL аватарок)
							if (resourceType === 'image') {
								req.continue();
								return;
							}

							req.continue();
						});

						// Отключаем JavaScript для ускорения
						await page.setJavaScriptEnabled(false);
					}

					// Устанавливаем размер страницы с улучшенным DPR для качества аватарок
					const devicePixelRatio =
						quality >= 95 ? 2.5 : quality >= 90 ? 2 : 1.5; // Улучшенное качество для аватарок
					await page.setViewport({
						width: viewportWidth,
						height: viewportHeight,
						deviceScaleFactor: devicePixelRatio,
					});

					// Загружаем HTML с таймаутом
					await page.setContent(html, {
						waitUntil: optimizeForSpeed ? 'domcontentloaded' : 'networkidle0',
						timeout: 15000,
					});

					// Ожидаем полной загрузки шрифтов, если не оптимизируем для скорости
					if (!optimizeForSpeed) {
						await page.evaluateHandle('document.fonts.ready');
					}

					// ИСПРАВЛЕНИЕ: Убираем fullPage, так как используем clip
					const screenshot = await page.screenshot({
						type: 'jpeg',
						quality: Math.max(85, Math.min(100, quality)), // Повышаем минимальное качество до 85 для аватарок
						optimizeForSpeed: false, // Отключаем оптимизацию для лучшего качества аватарок
						clip: {
							x: 0,
							y: 0,
							width: viewportWidth,
							height: viewportHeight,
						},
					});

					// Валидация сгенерированного изображения
					if (!screenshot || screenshot.length === 0) {
						throw new Error('Скриншот пустой или не сгенерирован');
					}

					// Диагностика screenshot Buffer в worker
					console.log(`🔬 Worker: Buffer диагностика:
  - Размер: ${screenshot.length}
  - Тип: ${typeof screenshot}
  - Конструктор: ${screenshot.constructor.name}
  - Buffer.isBuffer: ${Buffer.isBuffer(screenshot)}
  - instanceof Buffer: ${screenshot instanceof Buffer}`);

					// Проверяем что это валидный JPEG
					const jpegHeader = screenshot.subarray(0, 3);
					const isValidJPEG =
						jpegHeader[0] === 0xff &&
						jpegHeader[1] === 0xd8 &&
						jpegHeader[2] === 0xff;

					if (!isValidJPEG) {
						throw new Error(
							`Сгенерированный файл не является валидным JPEG. Заголовок: ${jpegHeader.toString(
								'hex',
							)}`,
						);
					}

					// Проверяем минимальный размер
					if (screenshot.length < 1024) {
						// Меньше 1KB подозрительно
						throw new Error(
							`Сгенерированное изображение слишком маленькое: ${screenshot.length} байт`,
						);
					}

					const fileSizeMB = screenshot.length / (1024 * 1024);
					if (fileSizeMB > 10) {
						// Больше 10MB тоже подозрительно
						throw new Error(
							`Сгенерированное изображение слишком большое: ${fileSizeMB.toFixed(
								2,
							)}MB`,
						);
					}

					parentPort!.postMessage({
						success: true,
						imageBuffer: screenshot,
						stats: {
							size: screenshot.length,
							sizeMB: fileSizeMB,
							isValidJPEG: true,
						},
					});
				} finally {
					await page.close();
					await browser.close();
				}
			} catch (error) {
				parentPort!.postMessage({
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		},
	);
}

/**
 * Создает Worker для генерации изображения с настройками качества
 */
export async function generateImageInWorker(
	html: string,
	viewportWidth: number = 550,
	viewportHeight: number = 800,
	quality: number = 85,
	optimizeForSpeed: boolean = true,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(__filename);

		// Таймаут для воркера (60 секунд)
		const timeout = setTimeout(() => {
			worker.terminate();
			reject(
				new Error(
					'Worker timeout: генерация изображения заняла слишком много времени',
				),
			);
		}, 60000);

		worker.postMessage({
			html,
			viewportWidth,
			viewportHeight,
			quality,
			optimizeForSpeed,
		});

		worker.on(
			'message',
			(result: {
				success: boolean;
				imageBuffer?: Buffer;
				error?: string;
				stats?: {
					size: number;
					sizeMB: number;
					isValidJPEG: boolean;
				};
			}) => {
				clearTimeout(timeout);
				worker.terminate();

				if (result.success && result.imageBuffer) {
					// Диагностика полученного Buffer из worker
					console.log(`🔬 Main: Buffer из worker диагностика:
  - Размер: ${result.imageBuffer.length}
  - Тип: ${typeof result.imageBuffer}
  - Конструктор: ${result.imageBuffer.constructor.name}
  - Buffer.isBuffer: ${Buffer.isBuffer(result.imageBuffer)}
  - instanceof Buffer: ${result.imageBuffer instanceof Buffer}`);

					// Логируем статистику генерации
					if (result.stats) {
						console.log(
							`✅ Изображение сгенерировано: ${result.stats.sizeMB.toFixed(
								2,
							)}MB, валидный JPEG: ${result.stats.isValidJPEG}`,
						);
					}
					resolve(result.imageBuffer);
				} else {
					reject(new Error(result.error || 'Worker failed'));
				}
			},
		);

		worker.on('error', (error) => {
			clearTimeout(timeout);
			worker.terminate();
			reject(error);
		});

		worker.on('exit', (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`Worker stopped with exit code ${code}`));
			}
		});
	});
}
