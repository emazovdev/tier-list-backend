import * as dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

// Определяем переменные окружения с проверкой наличия
const getEnvVar = (key: string, defaultValue?: string): string => {
	const value = process.env[key] || defaultValue;

	if (value === undefined) {
		throw new Error(`Переменная окружения ${key} не установлена`);
	}

	return value;
};

// Получаем URL Redis из разных возможных переменных окружения
const getRedisUrl = (): string => {
	// Сначала проверяем наличие публичного URL для локальной разработки
	if (process.env.REDIS_PUBLIC_URL) {
		return process.env.REDIS_PUBLIC_URL;
	}

	// Проверяем наличие основного URL
	if (process.env.REDIS_URL) {
		return process.env.REDIS_URL;
	}

	// Проверяем наличие Railway специфичных переменных
	if (process.env.REDISHOST && process.env.REDISPORT) {
		const password = process.env.REDISPASSWORD
			? `:${process.env.REDISPASSWORD}@`
			: '';
		const user = process.env.REDISUSER ? `${process.env.REDISUSER}:` : '';
		const url = `redis://${user}${password}${process.env.REDISHOST}:${process.env.REDISPORT}`;
		return url;
	}

	// Если нет ни одной переменной для Redis, возвращаем локальный URL
	console.warn(
		'Не найдены переменные окружения для Redis, используем локальный URL',
	);
	return 'redis://localhost:6379';
};

// Типизированные переменные окружения
export const config = {
	port: parseInt(getEnvVar('PORT', '3001'), 10),
	telegram: {
		botToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
		adminId: getEnvVar('TELEGRAM_ADMIN_ID'),
		botUsername: getEnvVar('TELEGRAM_BOT_USERNAME'),
	},
	webApp: {
		url: getEnvVar('WEB_APP_URL'),
	},
	cors: {
		origins: [getEnvVar('WEB_APP_URL'), 'https://myach-specialprojects.ru'],
	},
	r2: {
		accessKey: getEnvVar('R2_ACCESS_KEY'),
		secretKey: getEnvVar('R2_SECRET_KEY'),
		bucketName: getEnvVar('R2_BUCKET_NAME'),
		endpoint: getEnvVar('R2_ENDPOINT'),
		publicDomain: getEnvVar('R2_PUBLIC_DOMAIN', ''),
	},
	redis: {
		url: getRedisUrl(),
	},
};
