import { redisService } from './redis.service';
import { logger } from '../utils/logger';

/**
 * Многоуровневая система кэширования для высоких нагрузок
 * L1: In-memory cache (самый быстрый)
 * L2: Redis cache (разделяемый между инстансами)
 */
export class CacheService {
	private static instance: CacheService;

	// L1 Cache - In-memory
	private l1Cache: Map<string, { data: any; expiry: number; hits: number }> =
		new Map();

	// Настройки кэша
	private readonly L1_MAX_SIZE = 10000; // Максимум записей в L1
	private readonly L1_DEFAULT_TTL = 5 * 60 * 1000; // 5 минут для L1
	private readonly L2_DEFAULT_TTL = 30 * 60; // 30 минут для L2 (Redis)

	// Метрики
	private metrics = {
		l1Hits: 0,
		l1Misses: 0,
		l2Hits: 0,
		l2Misses: 0,
		evictions: 0,
	};

	private constructor() {
		// Очистка L1 кэша каждые 5 минут
		setInterval(() => {
			this.cleanExpiredL1();
		}, 5 * 60 * 1000);

		// Логирование метрик каждые 10 минут
		setInterval(() => {
			this.logMetrics();
		}, 10 * 60 * 1000);
	}

	public static getInstance(): CacheService {
		if (!CacheService.instance) {
			CacheService.instance = new CacheService();
		}
		return CacheService.instance;
	}

	/**
	 * Получение значения из кэша (L1 -> L2)
	 */
	public async get<T>(key: string): Promise<T | null> {
		// Проверяем L1 cache
		const l1Entry = this.l1Cache.get(key);
		if (l1Entry && l1Entry.expiry > Date.now()) {
			l1Entry.hits++;
			this.metrics.l1Hits++;
			return l1Entry.data as T;
		}

		// L1 miss
		this.metrics.l1Misses++;

		// Проверяем L2 cache (Redis)
		try {
			const l2Value = await redisService.get(key);
			if (l2Value) {
				this.metrics.l2Hits++;
				const data = JSON.parse(l2Value) as T;

				// Сохраняем в L1 для быстрого доступа
				this.setL1(key, data, this.L1_DEFAULT_TTL);

				return data;
			}
		} catch (error) {
			logger.error('Ошибка при получении из Redis:', 'CACHE', error);
		}

		// L2 miss
		this.metrics.l2Misses++;
		return null;
	}

	/**
	 * Сохранение значения в кэш (L1 + L2)
	 */
	public async set<T>(
		key: string,
		value: T,
		l1TtlMs: number = this.L1_DEFAULT_TTL,
		l2TtlSec: number = this.L2_DEFAULT_TTL,
	): Promise<void> {
		// Сохраняем в L1
		this.setL1(key, value, l1TtlMs);

		// Сохраняем в L2 (Redis)
		try {
			await redisService.set(key, JSON.stringify(value), l2TtlSec);
		} catch (error) {
			logger.error('Ошибка при сохранении в Redis:', 'CACHE', error);
		}
	}

	/**
	 * Удаление из кэша
	 */
	public async delete(key: string): Promise<void> {
		// Удаляем из L1
		this.l1Cache.delete(key);

		// Удаляем из L2
		try {
			await redisService.delete(key);
		} catch (error) {
			logger.error('Ошибка при удалении из Redis:', 'CACHE', error);
		}
	}

	/**
	 * Удаление по шаблону
	 */
	public async deletePattern(pattern: string): Promise<void> {
		// Удаляем из L1 по шаблону
		const regex = new RegExp(pattern.replace(/\*/g, '.*'));
		for (const key of this.l1Cache.keys()) {
			if (regex.test(key)) {
				this.l1Cache.delete(key);
			}
		}

		// Удаляем из L2
		try {
			const keys = await redisService.keys(pattern);
			if (keys.length > 0) {
				await redisService.deleteMany(keys);
			}
		} catch (error) {
			logger.error('Ошибка при удалении по шаблону из Redis:', 'CACHE', error);
		}
	}

	/**
	 * Получение или установка значения (cache-aside pattern)
	 */
	public async getOrSet<T>(
		key: string,
		fetchFunction: () => Promise<T>,
		l1TtlMs: number = this.L1_DEFAULT_TTL,
		l2TtlSec: number = this.L2_DEFAULT_TTL,
	): Promise<T> {
		// Пытаемся получить из кэша
		const cached = await this.get<T>(key);
		if (cached !== null) {
			return cached;
		}

		// Если нет в кэше, вызываем функцию
		const value = await fetchFunction();

		// Сохраняем в кэш
		await this.set(key, value, l1TtlMs, l2TtlSec);

		return value;
	}

	/**
	 * Сохранение в L1 кэш
	 */
	private setL1<T>(key: string, value: T, ttlMs: number): void {
		// Проверяем размер кэша и очищаем при необходимости
		if (this.l1Cache.size >= this.L1_MAX_SIZE) {
			this.evictL1();
		}

		this.l1Cache.set(key, {
			data: value,
			expiry: Date.now() + ttlMs,
			hits: 0,
		});
	}

	/**
	 * Очистка просроченных записей из L1
	 */
	private cleanExpiredL1(): void {
		const now = Date.now();
		let cleaned = 0;

		for (const [key, entry] of this.l1Cache.entries()) {
			if (entry.expiry <= now) {
				this.l1Cache.delete(key);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.info(
				`🧹 Очищено ${cleaned} просроченных записей из L1 кэша`,
				'CACHE',
			);
		}
	}

	/**
	 * Вытеснение записей из L1 (LFU - Least Frequently Used)
	 */
	private evictL1(): void {
		const entries = Array.from(this.l1Cache.entries());

		// Сортируем по количеству обращений (по возрастанию)
		entries.sort((a, b) => a[1].hits - b[1].hits);

		// Удаляем 10% записей
		const toEvict = Math.ceil(entries.length * 0.1);

		for (let i = 0; i < toEvict && i < entries.length; i++) {
			this.l1Cache.delete(entries[i][0]);
			this.metrics.evictions++;
		}

		logger.info(`🧹 Вытеснено ${toEvict} записей из L1 кэша`, 'CACHE');
	}

	/**
	 * Логирование метрик
	 */
	private logMetrics(): void {
		const total = this.metrics.l1Hits + this.metrics.l1Misses;
		const l1HitRate =
			total > 0 ? ((this.metrics.l1Hits / total) * 100).toFixed(2) : '0.00';

		const l2Total = this.metrics.l2Hits + this.metrics.l2Misses;
		const l2HitRate =
			l2Total > 0 ? ((this.metrics.l2Hits / l2Total) * 100).toFixed(2) : '0.00';

		logger.info(
			`📊 Cache метрики: L1(${this.l1Cache.size}/${this.L1_MAX_SIZE}, ${l1HitRate}% hit rate), ` +
				`L2(${l2HitRate}% hit rate), Evictions: ${this.metrics.evictions}`,
			'CACHE',
		);
	}

	/**
	 * Получение метрик
	 */
	public getMetrics() {
		return {
			...this.metrics,
			l1Size: this.l1Cache.size,
			l1MaxSize: this.L1_MAX_SIZE,
			l1HitRate:
				this.metrics.l1Hits / (this.metrics.l1Hits + this.metrics.l1Misses) ||
				0,
			l2HitRate:
				this.metrics.l2Hits / (this.metrics.l2Hits + this.metrics.l2Misses) ||
				0,
		};
	}

	/**
	 * Очистка всех кэшей
	 */
	public async flush(): Promise<void> {
		this.l1Cache.clear();
		await redisService.flushAll();
		logger.info('🧹 Все кэши очищены', 'CACHE');
	}
}

/**
 * Специализированные кэши для разных типов данных
 */
export class SpecializedCaches {
	private static cacheService = CacheService.getInstance();

	/**
	 * Кэш для клубов (долгоживущий)
	 */
	static async getClub<T>(
		clubId: string,
		fetchFn: () => Promise<T>,
	): Promise<T> {
		return this.cacheService.getOrSet(
			`club:${clubId}`,
			fetchFn,
			10 * 60 * 1000, // 10 минут L1
			60 * 60, // 1 час L2
		);
	}

	/**
	 * Кэш для игроков (среднеживущий)
	 */
	static async getPlayers<T>(
		clubId: string,
		fetchFn: () => Promise<T>,
	): Promise<T> {
		return this.cacheService.getOrSet(
			`players:${clubId}`,
			fetchFn,
			5 * 60 * 1000, // 5 минут L1
			30 * 60, // 30 минут L2
		);
	}

	/**
	 * Кэш для URL изображений (долгоживущий)
	 */
	static async getImageUrls<T>(
		key: string,
		fetchFn: () => Promise<T>,
	): Promise<T> {
		return this.cacheService.getOrSet(
			`image_urls:${key}`,
			fetchFn,
			30 * 60 * 1000, // 30 минут L1
			6 * 60 * 60, // 6 часов L2
		);
	}

	/**
	 * Кэш для аналитики (короткоживущий)
	 */
	static async getAnalytics<T>(
		key: string,
		fetchFn: () => Promise<T>,
	): Promise<T> {
		return this.cacheService.getOrSet(
			`analytics:${key}`,
			fetchFn,
			2 * 60 * 1000, // 2 минуты L1
			10 * 60, // 10 минут L2
		);
	}

	/**
	 * Инвалидация кэша клубов
	 */
	static async invalidateClubs(): Promise<void> {
		await this.cacheService.deletePattern('club:*');
		await this.cacheService.deletePattern('players:*');
	}

	/**
	 * Инвалидация кэша аналитики
	 */
	static async invalidateAnalytics(): Promise<void> {
		await this.cacheService.deletePattern('analytics:*');
	}
}

export const cacheService = CacheService.getInstance();
