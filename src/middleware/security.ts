import { Request, Response, NextFunction } from 'express';

/**
 * Middleware для установки базовых заголовков безопасности
 */
export const securityHeaders = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Защита от XSS атак
	res.setHeader('X-XSS-Protection', '1; mode=block');

	// Запрет на отображение сайта во фреймах (защита от clickjacking)
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');

	// Запрет на угадывание MIME-типа (защита от MIME-sniffing)
	res.setHeader('X-Content-Type-Options', 'nosniff');

	// Установка политики безопасности контента (CSP)
	res.setHeader(
		'Content-Security-Policy',
		"default-src 'self'; " +
			"script-src 'self' 'unsafe-inline'; " +
			"style-src 'self' 'unsafe-inline'; " +
			"img-src 'self' data: https:; " +
			"connect-src 'self' https:; " +
			"font-src 'self'; " +
			"object-src 'none'; " +
			"media-src 'self'; " +
			"frame-src 'self' https://t.me;",
	);

	// Установка политики реферера
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Запрет на кэширование конфиденциальных данных
	if (req.path.includes('/api/auth') || req.path.includes('/api/admin')) {
		res.setHeader(
			'Cache-Control',
			'no-store, no-cache, must-revalidate, proxy-revalidate',
		);
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.setHeader('Surrogate-Control', 'no-store');
	}

	next();
};

/**
 * Middleware для проверки и ограничения размера запросов
 */
export const requestSizeLimit = (
	maxBodySize: number = 10 * 1024 * 1024, // 10MB по умолчанию
) => {
	return (req: Request, res: Response, next: NextFunction) => {
		// Проверяем Content-Length заголовок
		const contentLength = parseInt(req.headers['content-length'] || '0', 10);

		if (contentLength > maxBodySize) {
			res.status(413).json({
				error: 'Размер запроса превышает допустимый лимит',
				limit: `${Math.round(maxBodySize / (1024 * 1024))}MB`,
			});
			return;
		}

		next();
	};
};

/**
 * Middleware для проверки и ограничения частоты запросов по API ключу
 * Используется для API клиентов (не для обычных пользователей)
 */
interface ApiKeyLimits {
	[key: string]: {
		count: number;
		resetTime: number;
		limit: number;
		windowMs: number;
	};
}

const apiKeyLimits: ApiKeyLimits = {};

export const apiKeyRateLimit = (
	defaultLimit: number = 1000, // Запросов в окне времени
	defaultWindowMs: number = 60 * 60 * 1000, // 1 час по умолчанию
) => {
	return (req: Request, res: Response, next: NextFunction) => {
		// Получаем API ключ из заголовка или query параметра
		const apiKey =
			(req.headers['x-api-key'] as string) || (req.query.api_key as string);

		// Если API ключ не предоставлен, пропускаем
		if (!apiKey) {
			next();
			return;
		}

		const now = Date.now();

		// Инициализируем лимит для API ключа, если его нет
		if (!apiKeyLimits[apiKey]) {
			apiKeyLimits[apiKey] = {
				count: 0,
				resetTime: now + defaultWindowMs,
				limit: defaultLimit,
				windowMs: defaultWindowMs,
			};
		}

		// Сбрасываем счетчик, если время истекло
		if (apiKeyLimits[apiKey].resetTime < now) {
			apiKeyLimits[apiKey].count = 0;
			apiKeyLimits[apiKey].resetTime = now + apiKeyLimits[apiKey].windowMs;
		}

		// Увеличиваем счетчик
		apiKeyLimits[apiKey].count++;

		// Если превышен лимит, возвращаем ошибку
		if (apiKeyLimits[apiKey].count > apiKeyLimits[apiKey].limit) {
			res.status(429).json({
				error: 'Превышен лимит запросов для API ключа',
				retryAfter: Math.ceil((apiKeyLimits[apiKey].resetTime - now) / 1000),
			});
			return;
		}

		// Добавляем заголовки с информацией о лимитах
		res.setHeader('X-RateLimit-Limit', apiKeyLimits[apiKey].limit);
		res.setHeader(
			'X-RateLimit-Remaining',
			apiKeyLimits[apiKey].limit - apiKeyLimits[apiKey].count,
		);
		res.setHeader(
			'X-RateLimit-Reset',
			Math.ceil(apiKeyLimits[apiKey].resetTime / 1000),
		);

		next();
	};
};
