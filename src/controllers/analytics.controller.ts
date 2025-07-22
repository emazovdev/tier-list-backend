import { Response, NextFunction } from 'express';
import { TelegramRequest } from '../types/api';
import { AnalyticsService, EventType } from '../services/analytics.service';
import {
	withCache,
	invalidateCache,
	invalidateAnalyticsCache,
	createCacheOptions,
} from '../utils/cacheUtils';
import { isUserAdmin, getTelegramIdFromRequest } from '../utils/roleUtils';

// Константы для кэширования
const CACHE_KEYS = {
	STATS: 'cache:analytics:stats',
	DETAILED_STATS: 'cache:analytics:detailed_stats:',
};

/**
 * Логирует событие пользователя
 */
export const logEvent = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;
		const { eventType, metadata } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		if (!eventType || !Object.values(EventType).includes(eventType)) {
			res.status(400).json({ error: 'Некорректный тип события' });
			return;
		}

		const telegramId = telegramUser.id.toString();
		await AnalyticsService.logEvent(telegramId, eventType, metadata);

		// НЕ инвалидируем кэш статистики - обычные пользователи не имеют доступа к статистике

		res.json({ ok: true, message: 'Событие зарегистрировано' });
	} catch (error) {
		console.error('Ошибка при логировании события:', error);
		res.status(500).json({ error: 'Ошибка сервера' });
	}
};

/**
 * Начинает игровую сессию
 */
export const startGameSession = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;
		const { clubId } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		if (!clubId) {
			res.status(400).json({ error: 'ID клуба обязателен' });
			return;
		}

		const telegramId = telegramUser.id.toString();

		// Истекаем старые сессии перед созданием новой
		await AnalyticsService.expireOldSessions(24);

		// Проверяем, нужно ли логировать APP_START
		const shouldLogAppStart = await AnalyticsService.shouldLogAppStart(
			telegramId,
		);

		const sessionId = await AnalyticsService.startGameSession(
			telegramId,
			clubId,
		);

		// Логируем событие запуска приложения только если нужно
		if (shouldLogAppStart) {
			await AnalyticsService.logEvent(telegramId, EventType.APP_START, {
				clubId,
			});
		}

		// Логируем событие начала игры только при создании новой сессии
		if (sessionId) {
			await AnalyticsService.logEvent(telegramId, EventType.GAME_START, {
				clubId,
				sessionId,
			});
		}

		res.json({
			ok: true,
			sessionId,
			message: sessionId
				? 'Игровая сессия начата'
				: 'Продолжение активной сессии',
		});
	} catch (error) {
		console.error('Ошибка при начале игровой сессии:', error);
		res.status(500).json({ error: 'Ошибка сервера' });
	}
};

/**
 * Завершает игровую сессию
 */
export const completeGameSession = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		const telegramId = telegramUser.id.toString();
		await AnalyticsService.completeGameSession(telegramId);

		// Логируем событие завершения игры
		await AnalyticsService.logEvent(telegramId, EventType.GAME_COMPLETED);

		// Инвалидируем кэш статистики при новых событиях
		res.json({
			ok: true,
			message: 'Игровая сессия завершена',
		});
	} catch (error) {
		console.error('Ошибка при завершении игровой сессии:', error);
		res.status(500).json({ error: 'Ошибка сервера' });
	}
};

/**
 * Принудительно завершает все незавершенные сессии пользователя
 */
export const forceCompleteAllSessions = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		const telegramId = telegramUser.id.toString();

		// Принудительно завершаем все активные сессии
		const completedCount = await AnalyticsService.forceCompleteUserSessions(
			telegramId,
		);

		res.json({
			ok: true,
			completedSessions: completedCount,
			message: `Принудительно завершено ${completedCount} сессий`,
		});
	} catch (error) {
		console.error('Ошибка при принудительном завершении сессий:', error);
		res.status(500).json({ error: 'Ошибка сервера' });
	}
};

/**
 * Получает статус активной сессии пользователя
 */
export const getActiveSession = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		const telegramId = telegramUser.id.toString();
		const activeSession = await AnalyticsService.getActiveSession(telegramId);

		res.json({
			ok: true,
			activeSession,
		});
	} catch (error) {
		console.error('Ошибка при получении активной сессии:', error);
		res.status(500).json({ error: 'Ошибка сервера' });
	}
};

/**
 * Получает общую статистику (только для админов)
 */
export const getStats = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		// Проверяем, является ли пользователь админом (админы всегда получают актуальные данные)
		const telegramId = getTelegramIdFromRequest(req);
		const isAdmin = telegramId ? await isUserAdmin(telegramId) : false;

		// Создаем опции кэширования с учетом роли пользователя
		const cacheOptions = createCacheOptions(isAdmin, { ttl: 300 });

		// Используем кэширование для получения статистики
		const stats = await withCache(
			async () => await AnalyticsService.getStats(),
			CACHE_KEYS.STATS,
			cacheOptions,
		);

		res.json({ ok: true, stats });
	} catch (error) {
		console.error('Ошибка при получении статистики:', error);
		res.status(500).json({ error: 'Ошибка при получении статистики' });
	}
};

/**
 * Получает детальную статистику (только для админов)
 */
export const getDetailedStats = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { days } = req.query;
		const daysNumber = days ? parseInt(days as string) : 7;

		console.log('Запрос детальной статистики на', daysNumber, 'дней');

		// Проверяем, является ли пользователь админом (админы всегда получают актуальные данные)
		const telegramId = getTelegramIdFromRequest(req);
		const isAdmin = telegramId ? await isUserAdmin(telegramId) : false;

		// Создаем опции кэширования с учетом роли пользователя
		const cacheOptions = createCacheOptions(isAdmin, { ttl: 300 });

		// Используем кэширование для получения детальной статистики
		const stats = await withCache(
			async () => await AnalyticsService.getDetailedStats(daysNumber),
			`${CACHE_KEYS.DETAILED_STATS}${daysNumber}`,
			cacheOptions,
		);

		console.log('Статистика получена успешно, отправляем ответ');

		res.json({ ok: true, stats });
	} catch (error) {
		console.error('Ошибка при получении детальной статистики:', error);
		res
			.status(500)
			.json({ error: 'Ошибка при получении детальной статистики' });
	}
};

/**
 * Сбрасывает всю аналитику (только для суперадминов)
 */
export const resetAnalytics = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		console.log(
			'Запрос на сброс аналитики от пользователя:',
			req.body.telegramUser?.id,
		);

		// Выполняем сброс аналитики
		const result = await AnalyticsService.resetAnalytics();

		// Инвалидируем весь кэш статистики
		await invalidateAnalyticsCache();

		console.log('Аналитика сброшена успешно:', result);

		res.json({
			ok: true,
			message: 'Аналитика успешно сброшена',
			data: {
				deletedUserEvents: result.deletedUserEvents,
				deletedGameSessions: result.deletedGameSessions,
				deletedUsers: result.deletedUsers,
			},
		});
	} catch (error: any) {
		console.error('Ошибка при сбросе аналитики:', error);

		// Более детальная информация об ошибке
		const errorMessage = error.message || 'Неизвестная ошибка';
		const errorCode = error.code || 'UNKNOWN';
		const errorMeta = error.meta || {};

		console.error(
			`Детали ошибки: код ${errorCode}, сообщение: ${errorMessage}, мета:`,
			errorMeta,
		);

		res.status(500).json({
			ok: false,
			error: 'Ошибка при сбросе аналитики',
			details: {
				message: errorMessage,
				code: errorCode,
				...(Object.keys(errorMeta).length > 0 ? { meta: errorMeta } : {}),
			},
		});
	}
};
