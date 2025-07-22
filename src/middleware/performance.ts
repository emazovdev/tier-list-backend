import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Middleware для отслеживания времени выполнения запросов
 */
export const requestTimer = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Сохраняем время начала запроса
	const start = Date.now();

	// Переопределяем метод end для установки заголовка до отправки
	const originalEnd = res.end;
	res.end = function (chunk?: any, encoding?: any, cb?: any) {
		// Вычисляем время выполнения
		const duration = Date.now() - start;

		// Добавляем информацию о времени выполнения в заголовки ответа
		// Устанавливаем заголовок до вызова оригинального end
		try {
			res.setHeader('X-Response-Time', `${duration}ms`);
		} catch (error) {
			// Игнорируем ошибки установки заголовков если они уже отправлены
		}

		// Если запрос выполняется долго, логируем предупреждение
		if (duration > 500) {
			logger.warn(
				`Медленный запрос: ${req.method} ${req.originalUrl} - ${duration}ms`,
				'PERFORMANCE',
			);
		}

		// Вызываем оригинальный метод end
		return originalEnd.call(this, chunk, encoding, cb);
	};

	next();
};

/**
 * КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Улучшенное кэширование HTTP-ответов
 * Исправляет проблему с застрявшими данными на мобильных устройствах
 */
export const httpCache = (req: Request, res: Response, next: NextFunction) => {
	// Для GET и HEAD запросов устанавливаем заголовки кэширования
	if (req.method === 'GET' || req.method === 'HEAD') {
		// Для статических ресурсов устанавливаем долгий TTL
		if (req.path.includes('/static/')) {
			res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 день
		}
		// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Для API клубов и игроков используем условное кэширование
		else if (req.path.startsWith('/api/')) {
			if (req.path.includes('/clubs') || req.path.includes('/players')) {
				// Условное кэширование с короткими интервалами для мобильных устройств
				res.setHeader('Cache-Control', 'private, max-age=60, must-revalidate'); // 1 минута
				// Генерируем ETag на основе времени для принудительной проверки
				const etag = `W/"clubs-${Math.floor(Date.now() / 60000)}"`;
				res.setHeader('ETag', etag);
				res.setHeader('Vary', 'Authorization'); // Кэшируем по пользователю
			} else {
				// Для остальных API запросов используем минимальное кэширование
				res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
				res.setHeader('ETag', `W/"${Date.now().toString(36)}"`);
			}
		}
	}

	next();
};

/**
 * Middleware для обработки условных запросов (If-None-Match)
 */
export const conditionalGet = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const ifNoneMatch = req.headers['if-none-match'];
	const etag = res.getHeader('ETag');

	if (ifNoneMatch && etag && ifNoneMatch === etag) {
		res.status(304).end(); // Not Modified
		return;
	}

	next();
};

/**
 * Middleware для оптимизации соединений
 */
export const connectionOptimizer = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Устанавливаем заголовок Keep-Alive для поддержания соединения
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('Keep-Alive', 'timeout=5, max=1000');

	next();
};

/**
 * НОВОЕ: Middleware для принудительной инвалидации кэша после изменений
 */
export const invalidateBrowserCache = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Только для POST, PUT, DELETE запросов к API клубов/игроков
	if (
		['POST', 'PUT', 'DELETE'].includes(req.method) &&
		req.path.startsWith('/api/') &&
		(req.path.includes('/clubs') || req.path.includes('/players'))
	) {
		// Добавляем заголовки для принудительной инвалидации кэша
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.setHeader('X-Cache-Invalidate', 'clubs,players');
	}

	next();
};

/**
 * Простой rate limiter для защиты от DoS атак
 * Примечание: для production рекомендуется использовать express-rate-limit с Redis
 */
const requestCounts: Record<string, { count: number; resetTime: number }> = {};

export const simpleRateLimit = (
	maxRequests: number = 100,
	windowMs: number = 60000,
) => {
	return (req: Request, res: Response, next: NextFunction) => {
		const ip = req.ip || req.socket.remoteAddress || 'unknown';
		const now = Date.now();

		// Инициализируем счетчик для IP, если его нет
		if (!requestCounts[ip] || requestCounts[ip].resetTime < now) {
			requestCounts[ip] = {
				count: 0,
				resetTime: now + windowMs,
			};
		}

		// Увеличиваем счетчик
		requestCounts[ip].count++;

		// Если превышен лимит, возвращаем ошибку
		if (requestCounts[ip].count > maxRequests) {
			res.status(429).json({
				error: 'Слишком много запросов. Пожалуйста, попробуйте позже.',
				retryAfter: Math.ceil((requestCounts[ip].resetTime - now) / 1000),
			});
			return;
		}

		next();
	};
};
