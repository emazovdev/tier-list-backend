import fs from 'fs'
import path from 'path'
import { prisma } from '../prisma'
import { logger } from '../utils/logger'
import { puppeteerPoolService } from './puppeteerPool.service'
import { TimewebStorageService } from './timewebStorage.service'

// Обновленная структура данных для генерации изображения
export interface ShareImageData {
	categorizedPlayerIds: { [categoryName: string]: string[] }
	categories: Array<{ name: string; color: string; slots: number }>
	clubId: string
}

// Настройки качества изображения
export interface ImageQualityOptions {
	quality?: number // 1-100, по умолчанию 85
	width?: number // ширина в пикселях, по умолчанию 550
	height?: number // высота в пикселях, по умолчанию 800
	optimizeForSpeed?: boolean // оптимизация для скорости, по умолчанию true
}

/**
 * Создает SVG плейсхолдер для аватара игрока
 */
function createPlayerAvatarPlaceholder(playerName: string): string {
	const colors = [
		'#FF6B6B',
		'#4ECDC4',
		'#45B7D1',
		'#96CEB4',
		'#FCEA2B',
		'#FF9FF3',
		'#54A0FF',
		'#5F27CD',
		'#00D2D3',
		'#FF9F43',
		'#6C5CE7',
		'#A29BFE',
		'#FD79A8',
		'#74B9FF',
		'#00B894',
	]

	// Генерируем цвет на основе имени игрока
	let hash = 0
	for (let i = 0; i < playerName.length; i++) {
		hash = playerName.charCodeAt(i) + ((hash << 5) - hash)
	}
	const color = colors[Math.abs(hash) % colors.length]

	const initial = playerName.charAt(0).toUpperCase()

	return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='${encodeURIComponent(
		color
	)}'/%3E%3Ctext x='50%25' y='50%25' font-size='14' text-anchor='middle' dy='.3em' fill='white' font-family='Arial, sans-serif' font-weight='bold'%3E${initial}%3C/text%3E%3C/svg%3E`
}

/**
 * Сервис для генерации изображений результатов игры
 */
export class ImageGenerationService {
	private static instance: ImageGenerationService

	// Кэш для ресурсов с TTL
	private resourcesCache: {
		fonts: Map<string, { data: string; timestamp: number }>
		images: Map<string, { data: string; timestamp: number }>
		isInitialized: boolean
		ttl: number // время жизни кэша в миллисекундах (1 час)
	} = {
		fonts: new Map(),
		images: new Map(),
		isInitialized: false,
		ttl: 60 * 60 * 1000, // 1 час
	}

	private constructor() {}

	public static getInstance(): ImageGenerationService {
		if (!ImageGenerationService.instance) {
			ImageGenerationService.instance = new ImageGenerationService()
		}
		return ImageGenerationService.instance
	}

	/**
	 * Проверяет, актуален ли кэш
	 */
	private isCacheValid(timestamp: number): boolean {
		return Date.now() - timestamp < this.resourcesCache.ttl
	}

	/**
	 * Предварительно загружает все ресурсы в кэш
	 */
	public async initializeResources(): Promise<void> {
		if (this.resourcesCache.isInitialized) {
			return
		}

		try {
			// Загружаем шрифты параллельно
			const fontPromises = [
				this.loadFontAsBase64('Montserrat-Regular.ttf'),
				this.loadFontAsBase64('Montserrat-Bold.ttf'),
			]

			// Загружаем изображения параллельно
			const imagePromises = [
				this.loadImageAsBase64('main_bg.jpg'),
				this.loadImageAsBase64('main_logo.png'),
			]

			// Ждем загрузки всех ресурсов
			await Promise.all([...fontPromises, ...imagePromises])

			this.resourcesCache.isInitialized = true
			logger.info(
				'Ресурсы для генерации изображений инициализированы',
				'IMAGE_GENERATION'
			)
		} catch (error) {
			logger.error(
				'Ошибка при инициализации ресурсов',
				'IMAGE_GENERATION',
				error
			)
			// Продолжаем работу даже с ошибками
			this.resourcesCache.isInitialized = true
		}
	}

	/**
	 * Асинхронно загружает шрифт в формате base64 для встраивания в HTML
	 */
	private async loadFontAsBase64(fontFileName: string): Promise<string> {
		try {
			// Проверяем кэш
			const cached = this.resourcesCache.fonts.get(fontFileName)
			if (cached && this.isCacheValid(cached.timestamp)) {
				return cached.data
			}

			// Путь к шрифтам относительно корня проекта
			const fontPath = path.join(process.cwd(), 'assets', 'fonts', fontFileName)

			// Проверяем существование файла асинхронно
			try {
				await fs.promises.access(fontPath)
			} catch {
				logger.silentImageProcess(`Шрифт не найден: ${fontFileName}`)
				this.resourcesCache.fonts.set(fontFileName, {
					data: '',
					timestamp: Date.now(),
				})
				return ''
			}

			// Читаем и кодируем шрифт в base64 асинхронно
			const fontBuffer = await fs.promises.readFile(fontPath)
			const base64Font = fontBuffer.toString('base64')

			// Кэшируем результат с временной меткой
			this.resourcesCache.fonts.set(fontFileName, {
				data: base64Font,
				timestamp: Date.now(),
			})
			return base64Font
		} catch (error) {
			logger.silentImageProcess(
				`Ошибка при загрузке шрифта ${fontFileName}: ${
					(error as any)?.message || 'Unknown error'
				}`
			)
			this.resourcesCache.fonts.set(fontFileName, {
				data: '',
				timestamp: Date.now(),
			})
			return ''
		}
	}

	/**
	 * Асинхронно загружает изображение в формате base64 для встраивания в HTML
	 */
	private async loadImageAsBase64(imageFileName: string): Promise<string> {
		try {
			// Проверяем кэш
			const cached = this.resourcesCache.images.get(imageFileName)
			if (cached && this.isCacheValid(cached.timestamp)) {
				return cached.data
			}

			// Путь к изображениям относительно корня проекта
			const imagePath = path.join(process.cwd(), 'assets', imageFileName)

			// Проверяем существование файла асинхронно
			try {
				await fs.promises.access(imagePath)
			} catch {
				console.warn(`⚠️ Изображение не найдено: ${imagePath}`)
				this.resourcesCache.images.set(imageFileName, {
					data: '',
					timestamp: Date.now(),
				})
				return ''
			}

			// Читаем и кодируем изображение в base64 асинхронно
			const imageBuffer = await fs.promises.readFile(imagePath)
			const extension = path.extname(imageFileName).toLowerCase()

			// Определяем MIME-тип
			let mimeType = 'image/jpeg'
			if (extension === '.png') mimeType = 'image/png'
			else if (extension === '.jpg' || extension === '.jpeg')
				mimeType = 'image/jpeg'
			else if (extension === '.gif') mimeType = 'image/gif'
			else if (extension === '.webp') mimeType = 'image/webp'

			const dataUri = `data:${mimeType};base64,${imageBuffer.toString(
				'base64'
			)}`

			// Кэшируем результат с временной меткой
			this.resourcesCache.images.set(imageFileName, {
				data: dataUri,
				timestamp: Date.now(),
			})
			return dataUri
		} catch (error) {
			console.error('❌ Ошибка при загрузке изображения:', error)
			this.resourcesCache.images.set(imageFileName, {
				data: '',
				timestamp: Date.now(),
			})
			return ''
		}
	}

	/**
	 * Асинхронно генерирует CSS для встраивания шрифтов
	 */
	private async generateFontFaces(): Promise<string> {
		// Список шрифтов для загрузки
		const fonts = [
			{ file: 'Montserrat-Regular.ttf', weight: 400, style: 'normal' },
			{ file: 'Montserrat-Bold.ttf', weight: 700, style: 'normal' },
		]

		// Загружаем все шрифты параллельно
		const fontPromises = fonts.map(async font => {
			const base64Font = await this.loadFontAsBase64(font.file)

			if (!base64Font) return ''

			return `
      @font-face {
        font-family: 'Montserrat';
        src: url(data:font/truetype;charset=utf-8;base64,${base64Font}) format('truetype');
        font-weight: ${font.weight};
        font-style: ${font.style};
        font-display: swap;
      }
    `
		})

		const fontCssArray = await Promise.all(fontPromises)
		return fontCssArray.filter(css => css !== '').join('\n')
	}

	/**
	 * Получает данные клуба и игроков из базы данных с кэшированием
	 */
	private async getClubAndPlayersData(data: ShareImageData) {
		const storageService = new TimewebStorageService()

		// Используем оптимизированное логирование
		logger.silentImageProcess(`Получение данных для клуба ${data.clubId}`)

		// Получаем клуб с подписанным URL логотипа
		const club = await prisma.club.findUnique({
			where: { id: data.clubId },
		})

		if (!club) {
			throw new Error('Клуб не найден')
		}

		logger.silentImageProcess(`Клуб найден: ${club.name}`)

		// Получаем всех игроков одним запросом для оптимизации
		const allPlayerIds = Object.values(data.categorizedPlayerIds).flat()
		const players = await prisma.players.findMany({
			where: { id: { in: allPlayerIds } },
		})

		logger.silentImageProcess(
			`Игроков найдено: ${players.length} из ${allPlayerIds.length}`
		)

		// Собираем все ключи изображений для батч-обработки
		const logoKeys = club.logo ? [club.logo] : []
		const avatarKeys = players
			.map(player => player.avatar)
			.filter(Boolean) as string[]

		// Получаем все URL за один раз
		const [logoUrls, avatarUrls] = await Promise.all([
			storageService.getBatchFastUrls(logoKeys, 'logo'),
			storageService.getBatchFastUrls(avatarKeys, 'avatar'),
		])

		logger.silentImageProcess(
			`URLs получены: логотипы ${logoKeys.length}, аватары ${avatarKeys.length}`
		)

		const clubLogoUrl = club.logo ? logoUrls[club.logo] || '' : ''

		// Создаем карту игроков для быстрого поиска
		const playersMap = new Map()

		for (const player of players) {
			const avatarUrl = player.avatar ? avatarUrls[player.avatar] || '' : ''

			playersMap.set(player.id, {
				id: player.id,
				name: player.name,
				avatarUrl,
			})
		}

		logger.silentImageProcess(
			`Карта игроков создана: ${playersMap.size} записей`
		)

		return { club, clubLogoUrl, playersMap }
	}

	/**
	 * Генерирует оптимизированный HTML для рендера изображения
	 */
	private async generateHTML(
		data: ShareImageData,
		options: ImageQualityOptions = {}
	): Promise<string> {
		const { club, clubLogoUrl, playersMap } = await this.getClubAndPlayersData(
			data
		)

		// Убеждаемся, что ресурсы инициализированы
		await this.initializeResources()

		let fontFaces = ''
		try {
			fontFaces = await this.generateFontFaces()
		} catch (error) {
			console.error('❌ Ошибка при загрузке шрифтов:', error)
			// Продолжаем работу без локальных шрифтов
		}

		// Загружаем локальные изображения в base64 (теперь из кэша)
		const backgroundImage = await this.loadImageAsBase64('main_bg.jpg')
		const mainLogo = await this.loadImageAsBase64('main_logo.png')

		// Функция обработки названия клуба (синхронизировано с клиентом)
		const getDisplayClubName = (clubName: string): string => {
			const hasClub = clubName.toLowerCase().includes('клуб')
			const seasonMatch = clubName.match(/(\d{4}\/\d{2})/)

			if (hasClub && seasonMatch) {
				const season = seasonMatch[1]
				return `Мой тир-лист клубов ${season}`
			}

			return clubName
		}

		const displayClubName = getDisplayClubName(club.name)
		const showClubLogo = displayClubName === club.name

		const playersHTML = data.categories
			.map(category => {
				const playerIds = data.categorizedPlayerIds[category.name] || []

				const playersListHTML =
					playerIds.length > 0
						? playerIds
								.map(playerId => {
									const player = playersMap.get(playerId)

									if (!player) {
										console.warn(`⚠️ Игрок с ID ${playerId} не найден`)
										return ''
									}

									const playerAvatar =
										player.avatarUrl ||
										createPlayerAvatarPlaceholder(player.name)

									return `<img src="${playerAvatar}" alt="${
										player.name
									}" class="player-avatar" onerror="this.src='${createPlayerAvatarPlaceholder(
										player.name
									)}'" />`
								})
								.filter(html => html !== '') // Убираем пустые строки
								.join('')
						: '<div class="empty-category">— Пусто</div>'

				return `
        <div class="category-section" style="background-color: ${
					category.color
				}">
        	<span class="category-title">${category.name.toUpperCase()}</span>
          	<div class="category-players">
            	${playersListHTML}
          	</div>
        </div>
      `
			})
			.join('')

		return `
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Результаты игры</title>
        <style>
		${fontFaces}
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: 'Montserrat', 'Arial', sans-serif;
			${
				backgroundImage
					? `background: url('${backgroundImage}') no-repeat center center;`
					: 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);'
			}
			background-size: cover;
			width: ${options.width || 600}px;
			height: ${options.height || 800}px;
			color: white;
			padding: 20px;
			overflow: hidden;
		}

		.container {
			width: 100%;
			height: 100%;
			display: flex;
			flex-direction: column;
			justify-content: center;
			align-items: center;
		}

		.container-logo {
			display: flex;
			justify-content: center;
			margin-bottom: 25px;
		}

		.main-logo {
			width: 140px;
			height: auto;
			object-fit: contain;
		}

		.content {
			background: rgba(255, 255, 255, 0.98);
			border-radius: 23px;
			padding: 10px;
			width: 100%;
			max-height: calc(100% - 200px);
			overflow: hidden;
			box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
		}

		.tier-list-header {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 12px;
			margin-bottom: 15px;
		}

		.club-logo {
			width: 50px;
			height: 50px;
			object-fit: contain;
			border-radius: 8px;
		}

		.club-name {
			font-size: ${options.width && options.width > 600 ? '36px' : '28px'};
			font-weight: bold;
			color: #1a1a1a;
			text-align: center;
			line-height: 1.2;
		}

		.categories {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.category-section {
			border-radius: 13px;
			overflow: hidden;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
			padding: 5px 5px 5px 10px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			color: white;
			font-weight: bold;
			min-height: 70px;
		}

		.category-title {
			font-size: ${options.width && options.width > 600 ? '24px' : '20px'};
			font-weight: 700;
			text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
			flex-shrink: 0;
			min-width: 100px;
		}

		.category-players {
			display: grid;
			grid-template-columns: repeat(6, minmax(0, 1fr));
			gap: 5px; /* Увеличенный промежуток для 550px ширины */
			flex: 1;
			max-width: calc(100% - 120px);
		}

		.player-avatar {
			width: ${
				options.width && options.width >= 550
					? '55px'
					: options.width && options.width >= 500
					? '50px'
					: '45px'
			};
			height: ${
				options.width && options.width >= 550
					? '70px'
					: options.width && options.width >= 500
					? '65px'
					: '60px'
			};
			border-radius: 8px;
			object-fit: cover;
			border: 2px solid rgba(255, 255, 255, 0.8);
			box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
			image-rendering: -webkit-optimize-contrast; /* Улучшенное качество рендеринга */
			image-rendering: crisp-edges;
		}

		.empty-category {
			color: rgba(255, 255, 255, 0.8);
			font-style: italic;
			font-size: 16px;
			text-align: center;
			grid-column: 1 / -1;
		}

		.footer {
			height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			margin-top: 20px;
		}

		.watermark {
			color: rgba(255, 255, 255, 0.8);
			font-size: 14px;
			font-weight: 500;
			text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
		}
	</style>
    </head>
    	<body>
        	<div class="container">       
				<div class='container-logo'>
					${mainLogo ? `<img class='main-logo' src="${mainLogo}" alt="main_logo">` : ''}
				</div>
          	
				<div class="content">
            		<div class="tier-list-header">
                        ${
													showClubLogo && clubLogoUrl
														? `<img src="${clubLogoUrl}" alt="Логотип" class="club-logo" />`
														: ''
												}
                		<div class="club-name">${displayClubName}</div>
            		</div>
            
            		<div class="categories">
              			${playersHTML}
            		</div>
          		</div>
          
          		<div class="footer">
					<div class="watermark">@${
						process.env.TELEGRAM_BOT_USERNAME || 'myach_pro_bot'
					}</div>
				</div>
        	</div>
      </body>
      </html>
    `
	}

	/**
	 * Генерирует изображение на основе данных с настройками качества
	 */
	public async generateResultsImage(
		data: ShareImageData,
		options: ImageQualityOptions = {}
	): Promise<{ imageBuffer: Buffer; club: { name: string } }> {
		try {
			// Устанавливаем значения по умолчанию (оптимизированные размеры)
			const defaultOptions: Required<ImageQualityOptions> = {
				quality: 85,
				width: 550, // Оптимальный размер для аватарок
				height: 800, // Оптимальное соотношение сторон
				optimizeForSpeed: true,
			}

			const finalOptions = { ...defaultOptions, ...options }

			logger.silentImageProcess(
				`Генерация ${finalOptions.width}x${finalOptions.height}, качество ${finalOptions.quality}%`
			)

			// Сначала получаем данные клуба
			const { club } = await this.getClubAndPlayersData(data)

			// Генерируем HTML
			const html = await this.generateHTML(data, finalOptions)

			// Генерируем изображение через оптимизированный пул браузеров
			const startTime = Date.now()

			const imageBuffer = await puppeteerPoolService.generateImage({
				html,
				viewportWidth: finalOptions.width,
				viewportHeight: finalOptions.height,
				quality: finalOptions.quality,
				optimizeForSpeed: finalOptions.optimizeForSpeed,
			})

			const duration = Date.now() - startTime

			// Логируем результат через оптимизированный метод
			logger.imageGenerated(true, undefined, duration)

			// Диагностика Buffer сразу после генерации
			logger.info(`🔬 Диагностика Buffer после генерации:`, 'IMAGE_GENERATION')
			logger.info(`  - Размер: ${imageBuffer.length}`, 'IMAGE_GENERATION')
			logger.info(`  - Тип: ${typeof imageBuffer}`, 'IMAGE_GENERATION')
			logger.info(
				`  - Конструктор: ${imageBuffer.constructor.name}`,
				'IMAGE_GENERATION'
			)
			logger.info(
				`  - Buffer.isBuffer: ${Buffer.isBuffer(imageBuffer)}`,
				'IMAGE_GENERATION'
			)
			logger.info(
				`  - instanceof Buffer: ${imageBuffer instanceof Buffer}`,
				'IMAGE_GENERATION'
			)

			return {
				imageBuffer,
				club: { name: club.name },
			}
		} catch (error) {
			logger.imageGenerated(false)
			logger.error(
				'Ошибка при генерации изображения',
				'IMAGE_GENERATION',
				error as Error
			)
			throw error
		}
	}

	/**
	 * Очищает устаревший кэш ресурсов
	 */
	public cleanExpiredCache() {
		const now = Date.now()

		// Очищаем устаревшие шрифты
		for (const [key, value] of this.resourcesCache.fonts.entries()) {
			if (!this.isCacheValid(value.timestamp)) {
				this.resourcesCache.fonts.delete(key)
			}
		}

		// Очищаем устаревшие изображения
		for (const [key, value] of this.resourcesCache.images.entries()) {
			if (!this.isCacheValid(value.timestamp)) {
				this.resourcesCache.images.delete(key)
			}
		}

		logger.silentImageProcess('Очищен устаревший кэш ресурсов')
	}

	/**
	 * Полная очистка кэша при завершении работы
	 */
	public async cleanup() {
		this.resourcesCache.fonts.clear()
		this.resourcesCache.images.clear()
		this.resourcesCache.isInitialized = false
		logger.info('Кэш ресурсов полностью очищен', 'IMAGE_GENERATION')
	}
}

export const imageGenerationService = ImageGenerationService.getInstance()
