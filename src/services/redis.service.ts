import { Redis } from 'ioredis';
import { config } from '../config/env';

/**
 * Сервис для работы с Redis
 */
class RedisService {
	private client: Redis;

	constructor() {
		// Проверяем, содержит ли URL строку redis.railway.internal
		const redisUrl = config.redis.url;

		if (redisUrl.includes('redis.railway.internal')) {
			// Для Railway добавляем параметр family=0 для поддержки IPv6
			const url = new URL(redisUrl);

			// Создаем клиент с явными параметрами для поддержки IPv6
			this.client = new Redis({
				host: url.hostname,
				port: parseInt(url.port || '6379', 10),
				username: url.username || undefined,
				password: url.password || undefined,
				family: 0, // Включаем поддержку dual stack (IPv4 и IPv6)
			});
		} else {
			// Для других случаев используем обычный URL
			this.client = new Redis(redisUrl);
		}

		this.client.on('error', (err) => {
			console.error('Ошибка Redis:', err);
		});

		this.client.on('connect', () => {
			// Подключение к Redis
		});
	}

	/**
	 * Получить значение по ключу
	 */
	async get(key: string): Promise<string | null> {
		return this.client.get(key);
	}

	/**
	 * Установить значение по ключу
	 */
	async set(key: string, value: string, ttl?: number): Promise<'OK'> {
		if (ttl) {
			return this.client.set(key, value, 'EX', ttl);
		}
		return this.client.set(key, value);
	}

	/**
	 * Удалить значение по ключу
	 */
	async delete(key: string): Promise<number> {
		return this.client.del(key);
	}

	/**
	 * Проверить наличие ключа
	 */
	async exists(key: string): Promise<number> {
		return this.client.exists(key);
	}

	/**
	 * Очистить все кеши
	 */
	async flushAll(): Promise<'OK'> {
		return this.client.flushall();
	}

	/**
	 * Получить ключи по шаблону
	 */
	async keys(pattern: string): Promise<string[]> {
		return this.client.keys(pattern);
	}

	/**
	 * Удалить несколько ключей
	 */
	async deleteMany(keys: string[]): Promise<number> {
		if (keys.length === 0) return 0;
		return this.client.del(...keys);
	}

	/**
	 * Получить прямой доступ к Redis клиенту для специальных операций
	 */
	getClient(): Redis {
		return this.client;
	}
}

export const redisService = new RedisService();
