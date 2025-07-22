import { Request, Response, NextFunction } from 'express';
import { redisService } from '../services/redis.service';
import { logger } from '../utils/logger';

interface RateLimitOptions {
	windowMs: number;
	maxRequests: number;
	keyGenerator?: (req: Request) => string;
	message?: string;
	skipSuccessfulRequests?: boolean;
	skipFailedRequests?: boolean;
}

/**
 * Продвинутый rate limiter для высоких нагрузок
 * Использует Redis для синхронизации между кластерами
 */
export class AdvancedRateLimit {
	private options: Required<RateLimitOptions>;

	constructor(options: RateLimitOptions) {
		this.options = {
			keyGenerator: (req: Request) => {
				// Получаем реальный IP через заголовки proxy
				const forwarded = req.headers['x-forwarded-for'];
				const realIp = req.headers['x-real-ip'];
				const ip =
					(forwarded as string)?.split(',')[0] ||
					realIp ||
					req.ip ||
					req.socket.remoteAddress ||
					'unknown';
				return `rate_limit:${ip}`;
			},
			message: 'Слишком много запросов. Попробуйте позже.',
			skipSuccessfulRequests: false,
			skipFailedRequests: true,
			...options,
		};
	}

	/**
	 * Middleware функция
	 */
	public middleware() {
		return async (req: Request, res: Response, next: NextFunction) => {
			try {
				const key = this.options.keyGenerator(req);
				const now = Date.now();
				const windowStart = now - this.options.windowMs;

				// Используем Redis pipeline для атомарности
				const pipeline = (redisService as any).client.pipeline();

				// Удаляем старые записи
				pipeline.zremrangebyscore(key, 0, windowStart);

				// Добавляем текущий запрос
				pipeline.zadd(key, now, `${now}-${Math.random()}`);

				// Устанавливаем TTL для ключа
				pipeline.expire(key, Math.ceil(this.options.windowMs / 1000));

				// Получаем количество запросов в окне
				pipeline.zcard(key);

				const results = await pipeline.exec();
				const requestCount = (results?.[3]?.[1] as number) || 0;

				// Добавляем заголовки для клиента
				res.setHeader('X-RateLimit-Limit', this.options.maxRequests);
				res.setHeader(
					'X-RateLimit-Remaining',
					Math.max(0, this.options.maxRequests - requestCount),
				);
				res.setHeader(
					'X-RateLimit-Reset',
					new Date(now + this.options.windowMs).toISOString(),
				);

				if (requestCount > this.options.maxRequests) {
					const retryAfter = Math.ceil(this.options.windowMs / 1000);

					res.setHeader('Retry-After', retryAfter);
					res.status(429).json({
						error: this.options.message,
						retryAfter,
						limit: this.options.maxRequests,
						windowMs: this.options.windowMs,
					});

					// Логируем превышение лимита
					logger.warn(
						`Rate limit превышен для ${key}: ${requestCount}/${this.options.maxRequests}`,
						'RATE_LIMIT',
					);

					return;
				}

				// Упрощенная версия без сложной логики удаления
				// Просто отслеживаем количество запросов без попыток коррекции

				next();
			} catch (error) {
				logger.error('Ошибка в rate limiter:', 'RATE_LIMIT', error);
				// В случае ошибки разрешаем запрос
				next();
			}
		};
	}
}

/**
 * Фабричные функции для разных типов лимитов
 */
export const createRateLimit = {
	/**
	 * Общий лимит для API
	 */
	general: () =>
		new AdvancedRateLimit({
			windowMs: 60 * 1000, // 1 минута
			maxRequests: 1000, // 1000 запросов в минуту на IP
			message: 'Слишком много запросов. Попробуйте через минуту.',
		}),

	/**
	 * Строгий лимит для генерации изображений
	 */
	imageGeneration: () =>
		new AdvancedRateLimit({
			windowMs: 2 * 60 * 1000, // 2 минуты (сократили с 5)
			maxRequests: 20, // 20 изображений в 2 минуты (вместо 10 в 5 минут)
			message:
				'Превышен лимит генерации изображений. Попробуйте через 2 минуты.',
			keyGenerator: (req: Request) => {
				// Для аутентифицированных пользователей используем user ID
				const userId = (req as any).telegramUser?.id;
				if (userId) {
					return `rate_limit:image:user:${userId}`;
				}

				// Для неаутентифицированных - IP
				const forwarded = req.headers['x-forwarded-for'];
				const ip = (forwarded as string)?.split(',')[0] || req.ip || 'unknown';
				return `rate_limit:image:ip:${ip}`;
			},
		}),

	/**
	 * Очень строгий лимит для отправки изображений в чат (shareResults)
	 */
	shareResults: () =>
		new AdvancedRateLimit({
			windowMs: 10 * 60 * 1000, // 10 минут
			maxRequests: 3, // 3 отправки в чат за 10 минут
			message:
				'Превышен лимит отправки изображений в чат. Попробуйте через 10 минут.',
			keyGenerator: (req: Request) => {
				// Только по user ID для отправки в чат
				const userId = (req as any).telegramUser?.id;
				if (userId) {
					return `rate_limit:share:user:${userId}`;
				}

				// Fallback на IP если нет user ID
				const forwarded = req.headers['x-forwarded-for'];
				const ip = (forwarded as string)?.split(',')[0] || req.ip || 'unknown';
				return `rate_limit:share:ip:${ip}`;
			},
		}),

	/**
	 * Лимит для аутентификации
	 */
	auth: () =>
		new AdvancedRateLimit({
			windowMs: 15 * 60 * 1000, // 15 минут
			maxRequests: 50, // 50 попыток авторизации в 15 минут
			message: 'Слишком много попыток авторизации. Попробуйте через 15 минут.',
		}),

	/**
	 * Лимит для админских операций
	 */
	admin: () =>
		new AdvancedRateLimit({
			windowMs: 60 * 1000, // 1 минута
			maxRequests: 100, // 100 админских операций в минуту
			message: 'Превышен лимит админских операций.',
		}),
};

/**
 * DDoS защита - очень строгий лимит
 */
export const ddosProtection = new AdvancedRateLimit({
	windowMs: 1000, // 1 секунда
	maxRequests: 50, // 50 запросов в секунду
	message: 'Подозрение на DDoS атаку. Запрос заблокирован.',
});

/**
 * Burst protection - защита от всплесков
 */
export const burstProtection = new AdvancedRateLimit({
	windowMs: 10 * 1000, // 10 секунд
	maxRequests: 200, // 200 запросов в 10 секунд
	message: 'Слишком много запросов за короткое время.',
});
