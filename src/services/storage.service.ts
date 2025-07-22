import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'crypto'
import fs from 'fs'
import { config } from '../config/env'

interface CachedUrl {
	url: string
	expiresAt: number
}

/**
 * Оптимизированный сервис для работы с хранилищем Cloudflare R2
 */
export class StorageService {
	private s3Client: S3Client
	private bucketName: string
	private publicDomain: string
	private urlCache = new Map<string, CachedUrl>()

	constructor() {
		this.bucketName = config.r2.bucketName

		// Очищаем и нормализуем publicDomain
		let publicDomain =
			config.r2.publicDomain || `https://${this.bucketName}.r2.dev`

		// Удаляем потенциальные дублирования домена
		if (
			publicDomain.includes(
				'myach-specialprojects.ru/assets.myach-specialprojects.ru'
			)
		) {
			publicDomain = 'https://assets.myach-specialprojects.ru'
		}

		// Убираем trailing slash если есть
		this.publicDomain = publicDomain.replace(/\/$/, '')

		// Логируем итоговый publicDomain для отладки
		console.log(
			`📡 StorageService инициализирован с publicDomain: ${this.publicDomain}`
		)

		this.s3Client = new S3Client({
			region: 'auto',
			endpoint: config.r2.endpoint,
			credentials: {
				accessKeyId: config.r2.accessKey,
				secretAccessKey: config.r2.secretKey,
			},
		})

		// Очистка кэша каждый час
		setInterval(() => this.cleanExpiredCache(), 3600000)
	}

	/**
	 * Генерирует presigned URL для загрузки файла напрямую в R2
	 */
	async generateUploadUrl(
		fileName: string,
		contentType: string,
		folder: string = 'uploads'
	): Promise<{ uploadUrl: string; fileKey: string }> {
		const fileExt = fileName.split('.').pop()
		const randomName = crypto.randomBytes(16).toString('hex')
		const fileKey = `${folder}/${randomName}.${fileExt}`

		try {
			const command = new PutObjectCommand({
				Bucket: this.bucketName,
				Key: fileKey,
				ContentType: contentType,
			})

			const uploadUrl = await getSignedUrl(this.s3Client, command, {
				expiresIn: 300, // 5 минут на загрузку
			})

			return { uploadUrl, fileKey }
		} catch (error) {
			console.error('Ошибка генерации URL для загрузки:', error)
			throw new Error('Не удалось создать ссылку для загрузки файла')
		}
	}

	/**
	 * Получает оптимизированный URL для доступа к файлу
	 */
	async getOptimizedUrl(
		fileKey: string,
		options: {
			width?: number
			height?: number
			format?: 'webp' | 'jpeg' | 'png'
			quality?: number
		} = {}
	): Promise<string> {
		if (!fileKey) return ''

		// Проверяем кэш
		const cacheKey = `${fileKey}_${JSON.stringify(options)}`
		const cached = this.urlCache.get(cacheKey)

		if (cached && cached.expiresAt > Date.now()) {
			return cached.url
		}

		try {
			// Приоритет: используем публичный домен если он настроен
			if (
				this.publicDomain &&
				this.publicDomain !== `https://${this.bucketName}.r2.dev`
			) {
				const params = new URLSearchParams()
				if (options.width) params.set('w', options.width.toString())
				if (options.height) params.set('h', options.height.toString())
				if (options.format) params.set('f', options.format)
				if (options.quality) params.set('q', options.quality.toString())

				const url = `${this.publicDomain}/${fileKey}${
					params.toString() ? '?' + params.toString() : ''
				}`

				// Дополнительная защита от дублирования домена
				const finalUrl = url.replace(
					/https:\/\/myach-specialprojects\.ru\/assets\.myach-specialprojects\.ru/g,
					'https://assets.myach-specialprojects.ru'
				)

				// Кэшируем на 7 дней для публичных URL
				this.urlCache.set(cacheKey, {
					url: finalUrl,
					expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
				})

				return finalUrl
			}

			// Fallback на signed URL только если публичный домен не настроен
			const command = new GetObjectCommand({
				Bucket: this.bucketName,
				Key: fileKey,
			})

			const url = await getSignedUrl(this.s3Client, command, {
				expiresIn: 86400,
			})

			// Кэшируем на 23 часа для signed URLs
			this.urlCache.set(cacheKey, {
				url,
				expiresAt: Date.now() + 23 * 60 * 60 * 1000,
			})

			return url
		} catch (error) {
			console.error('Ошибка получения URL:', error)
			return ''
		}
	}

	/**
	 * Получает множественные URL за один запрос с оптимизацией
	 */
	async getBatchUrls(
		fileKeys: string[],
		options: {
			width?: number
			height?: number
			format?: 'webp' | 'jpeg' | 'png'
			quality?: number
		} = {}
	): Promise<Record<string, string>> {
		if (!fileKeys.length) return {}

		const result: Record<string, string> = {}
		const uncachedKeys: string[] = []

		// Сначала проверяем кэш для всех ключей
		for (const fileKey of fileKeys) {
			const cacheKey = `${fileKey}_${JSON.stringify(options)}`
			const cached = this.urlCache.get(cacheKey)

			if (cached && cached.expiresAt > Date.now()) {
				result[fileKey] = cached.url
			} else {
				uncachedKeys.push(fileKey)
			}
		}

		// Если все URL есть в кэше, возвращаем результат
		if (uncachedKeys.length === 0) {
			return result
		}

		// Для некэшированных ключей генерируем URL
		if (
			this.publicDomain &&
			this.publicDomain !== `https://${this.bucketName}.r2.dev`
		) {
			// Используем публичный домен - быстро и без API вызовов
			const params = new URLSearchParams()
			if (options.width) params.set('w', options.width.toString())
			if (options.height) params.set('h', options.height.toString())
			if (options.format) params.set('f', options.format)
			if (options.quality) params.set('q', options.quality.toString())

			const paramString = params.toString() ? '?' + params.toString() : ''

			for (const fileKey of uncachedKeys) {
				const url = `${this.publicDomain}/${fileKey}${paramString}`

				// Дополнительная защита от дублирования домена
				const finalUrl = url.replace(
					/https:\/\/myach-specialprojects\.ru\/assets\.myach-specialprojects\.ru/g,
					'https://assets.myach-specialprojects.ru'
				)

				const cacheKey = `${fileKey}_${JSON.stringify(options)}`

				// Кэшируем на 7 дней
				this.urlCache.set(cacheKey, {
					url: finalUrl,
					expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
				})

				result[fileKey] = finalUrl
			}
		} else {
			// Fallback на signed URLs - генерируем параллельно
			const promises = uncachedKeys.map(async fileKey => {
				try {
					const command = new GetObjectCommand({
						Bucket: this.bucketName,
						Key: fileKey,
					})

					const url = await getSignedUrl(this.s3Client, command, {
						expiresIn: 86400,
					})

					const cacheKey = `${fileKey}_${JSON.stringify(options)}`
					this.urlCache.set(cacheKey, {
						url,
						expiresAt: Date.now() + 23 * 60 * 60 * 1000,
					})

					return { fileKey, url }
				} catch (error) {
					console.error(`Ошибка получения URL для ${fileKey}:`, error)
					return { fileKey, url: '' }
				}
			})

			const urls = await Promise.all(promises)
			for (const { fileKey, url } of urls) {
				result[fileKey] = url
			}
		}

		return result
	}

	/**
	 * Быстрое получение оптимизированного URL для аватаров/логотипов
	 * Использует оптимальные настройки для быстрой загрузки
	 */
	async getFastImageUrl(
		fileKey: string,
		type: 'avatar' | 'logo' = 'avatar'
	): Promise<string> {
		if (!fileKey) return ''

		const defaultOptions = {
			avatar: { width: 150, height: 150, format: 'webp' as const, quality: 80 },
			logo: { width: 200, height: 200, format: 'webp' as const, quality: 85 },
		}

		return this.getOptimizedUrl(fileKey, defaultOptions[type])
	}

	/**
	 * Батч-получение быстрых URL для аватаров/логотипов
	 */
	async getBatchFastUrls(
		fileKeys: string[],
		type: 'avatar' | 'logo' = 'avatar'
	): Promise<Record<string, string>> {
		if (!fileKeys.length) return {}

		const defaultOptions = {
			avatar: { width: 150, height: 150, format: 'webp' as const, quality: 80 },
			logo: { width: 200, height: 200, format: 'webp' as const, quality: 85 },
		}

		return this.getBatchUrls(fileKeys, defaultOptions[type])
	}

	/**
	 * Генерирует подписанный URL для доступа к файлу (обратная совместимость)
	 */
	async getSignedUrl(
		fileKey: string,
		expiresIn: number = 86400
	): Promise<string> {
		return this.getOptimizedUrl(fileKey)
	}

	/**
	 * Загружает файл в R2 (оставляем для обратной совместимости)
	 */
	async uploadFile(
		file: Express.Multer.File,
		folder: string = 'uploads'
	): Promise<string> {
		const fileExt = file.originalname.split('.').pop()
		const randomName = crypto.randomBytes(16).toString('hex')
		const fileName = `${folder}/${randomName}.${fileExt}`

		try {
			await this.s3Client.send(
				new PutObjectCommand({
					Bucket: this.bucketName,
					Key: fileName,
					Body: fs.createReadStream(file.path),
					ContentType: file.mimetype,
				})
			)

			fs.unlinkSync(file.path)
			return fileName
		} catch (error) {
			console.error('Ошибка загрузки файла в R2:', error)
			throw new Error('Не удалось загрузить файл в хранилище')
		}
	}

	/**
	 * Удаляет файл из R2
	 */
	async deleteFile(fileKey: string): Promise<void> {
		try {
			await this.s3Client.send(
				new DeleteObjectCommand({
					Bucket: this.bucketName,
					Key: fileKey,
				})
			)

			// Очищаем кэш для этого файла
			for (const [key] of this.urlCache) {
				if (key.startsWith(fileKey)) {
					this.urlCache.delete(key)
				}
			}
		} catch (error) {
			console.error('Ошибка удаления файла из R2:', error)
			throw new Error('Не удалось удалить файл из хранилища')
		}
	}

	/**
	 * Очищает просроченные записи из кэша
	 */
	private cleanExpiredCache(): void {
		const now = Date.now()
		for (const [key, value] of this.urlCache) {
			if (value.expiresAt <= now) {
				this.urlCache.delete(key)
			}
		}
	}

	/**
	 * Принудительно очищает весь кэш URL (для обновления конфигурации)
	 */
	public clearUrlCache(): void {
		this.urlCache.clear()
		console.log('🗑️ Кэш URL StorageService очищен')
	}

	/**
	 * Получает статистику кэша
	 */
	getCacheStats(): { size: number; hitRatio: number } {
		return {
			size: this.urlCache.size,
			hitRatio: 0, // Можно добавить счетчики hit/miss
		}
	}
}
