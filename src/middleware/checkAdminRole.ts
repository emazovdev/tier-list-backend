import { Response, NextFunction } from 'express';
import { TelegramRequest } from '../types/api';
import { prisma } from '../prisma';
import { redisService } from '../services/redis.service';
import { config } from '../config/env';

// Кэш для проверки админов (TTL 5 минут)
const ADMIN_CACHE_TTL = 300;
const ADMIN_CACHE_PREFIX = 'admin:check:';

/**
 * КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Унифицированная проверка админа для согласованности с AdminService
 * Используется как в middleware, так и в сервисе
 */
export const checkIsAdminUser = async (
	telegramId: string,
): Promise<boolean> => {
	try {
		// Проверяем в таблице AdminUser
		const adminUser = await prisma.adminUser.findUnique({
			where: { telegramId },
		});

		if (adminUser) {
			return true;
		}

		// Fallback: проверяем переменную окружения (для совместимости)
		return telegramId === config.telegram.adminId;
	} catch (error) {
		console.error('Ошибка при проверке админа в middleware:', error);
		// Fallback на переменную окружения при ошибке БД
		return telegramId === config.telegram.adminId;
	}
};

/**
 * Функция для инвалидации кэша конкретного админа
 */
export const invalidateAdminCache = async (
	telegramId: string,
): Promise<void> => {
	try {
		const cacheKey = `${ADMIN_CACHE_PREFIX}${telegramId}`;
		await redisService.delete(cacheKey);
		console.log(`Кэш админа ${telegramId} успешно инвалидирован`);
	} catch (error) {
		console.warn(`Не удалось инвалидировать кэш админа ${telegramId}:`, error);
	}
};

/**
 * Функция для инвалидации всего кэша админов
 */
export const invalidateAllAdminCache = async (): Promise<void> => {
	try {
		const keys = await redisService.keys(`${ADMIN_CACHE_PREFIX}*`);
		if (keys.length > 0) {
			await redisService.deleteMany(keys);
			console.log(`Инвалидировано ${keys.length} записей кэша админов`);
		} else {
			console.log('Кэш админов уже был пуст');
		}
	} catch (error) {
		console.warn('Не удалось инвалидировать весь кэш админов:', error);
	}
};

/**
 * Middleware для проверки прав администратора по роли в базе данных
 */
export const checkAdminRole = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;

		if (!telegramUser || !telegramUser.id) {
			res.status(403).json({
				error: 'Доступ запрещен. Необходимо авторизоваться',
			});
			return;
		}

		const telegramId = telegramUser.id.toString();
		const cacheKey = `${ADMIN_CACHE_PREFIX}${telegramId}`;

		// ОПТИМИЗАЦИЯ: Проверяем кэш сначала
		try {
			const cachedResult = await redisService.get(cacheKey);
			if (cachedResult !== null) {
				const isAdmin = cachedResult === 'true';
				if (isAdmin) {
					next();
					return;
				} else {
					res.status(403).json({
						error: 'Доступ запрещен. Недостаточно прав',
					});
					return;
				}
			}
		} catch (cacheError) {
			// Если кэш недоступен, продолжаем с DB запросом
			console.warn('Redis недоступен для проверки админа, используем DB');
		}

		// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Используем унифицированную проверку админа
		const isAdmin = await checkIsAdminUser(telegramId);

		// Кэшируем результат
		try {
			await redisService.set(cacheKey, isAdmin.toString(), ADMIN_CACHE_TTL);
		} catch (cacheError) {
			// Ошибка кэширования не критична
			console.warn('Не удалось закэшировать результат проверки админа');
		}

		if (!isAdmin) {
			res.status(403).json({
				error: 'Доступ запрещен. Недостаточно прав',
			});
			return;
		}

		next();
	} catch (err) {
		console.error('Ошибка проверки прав доступа:', err);
		res.status(500).json({ error: 'Внутренняя ошибка сервера' });
	}
};
