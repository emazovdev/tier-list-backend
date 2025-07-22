import { Request, Response, NextFunction } from 'express';
import { validate } from '@telegram-apps/init-data-node';
import { parseInitData } from '../utils/initDataUtils';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Middleware для аутентификации через init data Telegram Mini App
 */
export function initDataAuth(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	try {
		const auth = req.header('Authorization') || '';

		// Логируем только важные события (без спама)

		if (!auth || !auth.startsWith('tma ')) {
			console.error(
				'Ошибка авторизации: отсутствует или неверный заголовок Authorization',
			);
			res
				.status(401)
				.json({ error: 'Доступ запрещен. Необходимо авторизоваться' });
			return;
		}

		const initDataRaw = auth.slice(4);

		// Инициализируем body, если он не определен
		if (!req.body) {
			req.body = {};
		}

		// Валидируем данные от Telegram
		validate(initDataRaw, config.telegram.botToken);

		// Парсим данные
		const initData = parseInitData(initDataRaw);

		if (!initData || !initData.user) {
			console.error(
				'Ошибка авторизации: некорректные данные пользователя в initData',
			);
			res.status(400).json({ error: 'Некорректные данные пользователя' });
			return;
		}

		// Добавляем данные пользователя и initData в request
		req.body.telegramUser = initData.user;
		req.body.initData = initData;

		// Успешная авторизация - логируем через оптимизированный logger
		logger.auth(initData.user.id.toString());
		next();
	} catch (e: any) {
		console.error('Ошибка обработки initData:', e);
		res.status(403).json({ error: e.message || 'Ошибка авторизации' });
	}
}

// Экспортируем как validateInitData для совместимости
export const validateInitData = initDataAuth;
