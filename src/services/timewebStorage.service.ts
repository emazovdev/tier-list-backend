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
 * Сервис работы с Timeweb S3, совместимый по интерфейсу со StorageService
 */
export class TimewebStorageService {
	private s3Client: S3Client
	private bucketName: string
	private publicDomain: string
	private urlCache = new Map<string, CachedUrl>()

	constructor() {
		this.bucketName = config.s3.bucketName
		this.publicDomain = (config.s3.publicDomain || '').replace(/\/$/, '')

		this.s3Client = new S3Client({
			region: config.s3.region || 'ru-1',
			endpoint: config.s3.endpoint,
			credentials: {
				accessKeyId: config.s3.accessKey,
				secretAccessKey: config.s3.secretKey,
			},
			forcePathStyle: true, // Timeweb рекомендует path-style
		})

		setInterval(() => this.cleanExpiredCache(), 3600000)
	}

	async generateUploadUrl(
		fileName: string,
		contentType: string,
		folder: string = 'uploads'
	): Promise<{ uploadUrl: string; fileKey: string }> {
		const fileExt = fileName.split('.').pop()
		const randomName = crypto.randomBytes(16).toString('hex')
		const fileKey = `${folder}/${randomName}.${fileExt}`

		const command = new PutObjectCommand({
			Bucket: this.bucketName,
			Key: fileKey,
			ContentType: contentType,
		})

		const uploadUrl = await getSignedUrl(this.s3Client, command, {
			expiresIn: 300,
		})

		return { uploadUrl, fileKey }
	}

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

		const cacheKey = `${fileKey}_${JSON.stringify(options)}`
		const cached = this.urlCache.get(cacheKey)
		if (cached && cached.expiresAt > Date.now()) return cached.url

		// Если настроен публичный домен (через CDN), формируем прямую ссылку
		if (this.publicDomain) {
			const params = new URLSearchParams()
			if (options.width) params.set('w', options.width.toString())
			if (options.height) params.set('h', options.height.toString())
			if (options.format) params.set('f', options.format)
			if (options.quality) params.set('q', options.quality.toString())

			const url = `${this.publicDomain}/${fileKey}${
				params.toString() ? '?' + params.toString() : ''
			}`
			this.urlCache.set(cacheKey, {
				url,
				expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
			})
			return url
		}

		// Иначе выдаём presigned GET на сам S3
		const command = new GetObjectCommand({
			Bucket: this.bucketName,
			Key: fileKey,
		})
		const url = await getSignedUrl(this.s3Client, command, { expiresIn: 86400 })
		this.urlCache.set(cacheKey, {
			url,
			expiresAt: Date.now() + 23 * 60 * 60 * 1000,
		})
		return url
	}

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
		const uncached: string[] = []

		for (const key of fileKeys) {
			const cacheKey = `${key}_${JSON.stringify(options)}`
			const cached = this.urlCache.get(cacheKey)
			if (cached && cached.expiresAt > Date.now()) {
				result[key] = cached.url
			} else {
				uncached.push(key)
			}
		}

		if (uncached.length === 0) return result

		if (this.publicDomain) {
			const params = new URLSearchParams()
			if (options.width) params.set('w', options.width.toString())
			if (options.height) params.set('h', options.height.toString())
			if (options.format) params.set('f', options.format)
			if (options.quality) params.set('q', options.quality.toString())
			const suffix = params.toString() ? '?' + params.toString() : ''

			for (const key of uncached) {
				const url = `${this.publicDomain}/${key}${suffix}`
				const cacheKey = `${key}_${JSON.stringify(options)}`
				this.urlCache.set(cacheKey, {
					url,
					expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
				})
				result[key] = url
			}
			return result
		}

		const urls = await Promise.all(
			uncached.map(async key => {
				try {
					const command = new GetObjectCommand({
						Bucket: this.bucketName,
						Key: key,
					})
					const url = await getSignedUrl(this.s3Client, command, {
						expiresIn: 86400,
					})
					const cacheKey = `${key}_${JSON.stringify(options)}`
					this.urlCache.set(cacheKey, {
						url,
						expiresAt: Date.now() + 23 * 60 * 60 * 1000,
					})
					return { key, url }
				} catch (e) {
					return { key, url: '' }
				}
			})
		)

		for (const { key, url } of urls) {
			result[key] = url
		}
		return result
	}

	async getFastImageUrl(
		fileKey: string,
		type: 'avatar' | 'logo' = 'avatar'
	): Promise<string> {
		if (!fileKey) return ''
		const defaults = {
			avatar: { width: 150, height: 150, format: 'webp' as const, quality: 80 },
			logo: { width: 200, height: 200, format: 'webp' as const, quality: 85 },
		}
		return this.getOptimizedUrl(fileKey, defaults[type])
	}

	async getBatchFastUrls(
		fileKeys: string[],
		type: 'avatar' | 'logo' = 'avatar'
	): Promise<Record<string, string>> {
		if (!fileKeys.length) return {}
		const defaults = {
			avatar: { width: 150, height: 150, format: 'webp' as const, quality: 80 },
			logo: { width: 200, height: 200, format: 'webp' as const, quality: 85 },
		}
		return this.getBatchUrls(fileKeys, defaults[type])
	}

	async getSignedUrl(
		fileKey: string,
		expiresIn: number = 86400
	): Promise<string> {
		return this.getOptimizedUrl(fileKey)
	}

	async uploadFile(
		file: Express.Multer.File,
		folder: string = 'uploads'
	): Promise<string> {
		const fileExt = file.originalname.split('.').pop()
		const randomName = crypto.randomBytes(16).toString('hex')
		const fileName = `${folder}/${randomName}.${fileExt}`

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
	}

	async deleteFile(fileKey: string): Promise<void> {
		await this.s3Client.send(
			new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileKey })
		)

		for (const [key] of this.urlCache) {
			if (key.startsWith(fileKey)) this.urlCache.delete(key)
		}
	}

	private cleanExpiredCache(): void {
		const now = Date.now()
		for (const [key, value] of this.urlCache) {
			if (value.expiresAt <= now) this.urlCache.delete(key)
		}
	}

	public clearUrlCache(): void {
		this.urlCache.clear()
		console.log('🗑️ Кэш URL TimewebStorageService очищен')
	}

	getCacheStats(): { size: number; hitRatio: number } {
		return {
			size: this.urlCache.size,
			hitRatio: 0,
		}
	}
}
