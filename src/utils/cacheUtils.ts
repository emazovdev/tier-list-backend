import { redisService } from '../services/redis.service'

/**
 * Опции кэширования
 */
interface CacheOptions {
	ttl?: number // время жизни кэша в секундах
	keyPrefix?: string // префикс для ключа кэша
	skipCache?: boolean // пропустить кэш (для админов)
}

/**
 * Функция для кэширования результатов асинхронных функций
 * @param fn Асинхронная функция, результат которой нужно кэшировать
 * @param key Ключ для кэширования (уже с префиксом)
 * @param options Опции кэширования
 * @returns Результат выполнения функции (из кэша или новый)
 */
export async function withCache<T>(
	fn: () => Promise<T>,
	key: string,
	options: CacheOptions = {}
): Promise<T> {
	const { ttl = 3600, keyPrefix = '', skipCache = false } = options
	const cacheKey = keyPrefix ? `${keyPrefix}${key}` : key // Используем ключ как есть, если префикс не указан

	// Если нужно пропустить кэш (например, для админов), выполняем функцию напрямую
	if (skipCache) {
		return await fn()
	}

	// Проверяем наличие данных в кэше
	const cachedData = await redisService.get(cacheKey)

	if (cachedData) {
		try {
			// Если данные есть, возвращаем их
			return JSON.parse(cachedData) as T
		} catch (error) {
			console.error('Ошибка при парсинге кэша:', error)
			// Если ошибка парсинга, продолжаем выполнение функции
		}
	}

	// Если кэша нет или произошла ошибка, выполняем функцию
	const result = await fn()

	// Сохраняем результат в кэш
	try {
		await redisService.set(cacheKey, JSON.stringify(result), ttl)
	} catch (error) {
		console.error('Ошибка при сохранении в кэш:', error)
	}

	return result
}

/**
 * Функция для очистки кэша по ключу или префиксу
 * @param keyPattern Ключ или шаблон ключа для очистки
 */
export async function invalidateCache(keyPattern: string): Promise<void> {
	try {
		// Получаем все ключи по шаблону
		const keys = await redisService.keys(keyPattern)

		// Если есть ключи, удаляем их
		if (keys.length > 0) {
			await redisService.deleteMany(keys)
		}
	} catch (error) {
		console.error('Ошибка при очистке кэша:', error)
	}
}

/**
 * Проверяет, является ли пользователь администратором
 * @param telegramUser Данные пользователя из Telegram
 * @returns true, если пользователь админ
 */
export function isAdmin(telegramUser: any): boolean {
	// Здесь можно добавить дополнительную логику проверки
	// Пока возвращаем false, так как роль проверяется в middleware
	return false
}

/**
 * Создает опции кэширования с учетом роли пользователя
 * @param isAdminUser Является ли пользователь админом
 * @param baseOptions Базовые опции кэширования
 * @returns Опции кэширования
 */
export function createCacheOptions(
	isAdminUser: boolean,
	baseOptions: CacheOptions = {}
): CacheOptions {
	return {
		...baseOptions,
		skipCache: isAdminUser, // Админы всегда получают актуальные данные
	}
}

/**
 * Очищает весь кеш связанный с клубами и игроками
 */
export async function invalidateClubsCache(): Promise<void> {
	try {
		// Очищаем все ключи связанные с клубами
		const patterns = ['cache:clubs:*']

		for (const pattern of patterns) {
			await invalidateCache(pattern)
		}
	} catch (error) {
		console.error('Ошибка при очистке кеша клубов:', error)
	}
}

/**
 * Полная инвалидация всех кешей связанных с данными (клубы, игроки, аналитика)
 * Используется при критических изменениях данных
 */
export async function invalidateAllDataCache(): Promise<void> {
	try {
		// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Добавляем импорт функции инвалидации админского кэша
		const { invalidateAllAdminCache } = await import(
			'../middleware/checkAdminRole'
		)

		// Очищаем все основные кеши приложения
		const patterns = [
			'cache:clubs:*',
			'cache:analytics:*',
			'cache:players:*', // если есть кеш игроков
			'cache:admin:*', // если есть кеш админов
		]

		// Параллельно очищаем обычные кеши и кеш админов
		const promises = [
			...patterns.map(pattern => invalidateCache(pattern)),
			invalidateAllAdminCache(), // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Очищаем кэш админов
		]

		await Promise.all(promises)

		console.log(
			'Выполнена полная инвалидация кеша данных включая админский кэш'
		)
	} catch (error) {
		console.error('Ошибка при полной инвалидации кеша:', error)
	}
}

/**
 * Очищает весь кеш аналитики
 */
export async function invalidateAnalyticsCache(): Promise<void> {
	try {
		// Очищаем все ключи связанные с аналитикой
		const patterns = ['cache:analytics:*']

		for (const pattern of patterns) {
			await invalidateCache(pattern)
		}
	} catch (error) {
		console.error('Ошибка при очистке кеша аналитики:', error)
	}
}

/**
 * Инвалидирует кэш изображений в StorageService
 * Используется при обновлении конфигурации R2 или исправлении URL
 */
export const invalidateImageUrlCache = (): void => {
	try {
		// Импортируем StorageService динамически чтобы избежать циклических зависимостей
		const { StorageService } = require('../services/storage.service')
		const storageService = new StorageService()
		storageService.clearUrlCache()

		console.log('✅ Кэш изображений успешно обновлен')
	} catch (error) {
		console.error('❌ Ошибка при обновлении кэша изображений:', error)
	}
}
