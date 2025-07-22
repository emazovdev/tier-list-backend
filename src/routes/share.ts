import express from 'express';
import { validateInitData } from '../middleware/validateInitData';
import { ShareController } from '../controllers/share.controller';
import { createRateLimit } from '../middleware/advancedRateLimit';
import { userImageRateLimit } from '../middleware/userRateLimit';
import { TelegramBotService } from '../bot/telegramBot';

/**
 * Создает роуты для шеринга с переданным экземпляром бота
 */
export const createShareRoutes = (botService: TelegramBotService) => {
	const router = express.Router();
	const shareController = new ShareController(botService);

	/**
	 * POST /api/share/results
	 * Генерирует изображение результатов и отправляет в Telegram
	 */
	router.post(
		'/results',
		validateInitData,
		userImageRateLimit.middleware(), // Новый лимит: 5 раз в день + интервал 10 мин
		createRateLimit.shareResults().middleware(), // Дополнительная защита от спама
		shareController.shareResults,
	);

	/**
	 * POST /api/share/preview
	 * Предварительный просмотр изображения (сжатое для быстрой загрузки)
	 */
	router.post(
		'/preview',
		validateInitData,
		userImageRateLimit.middleware(), // Применяем тот же лимит
		shareController.previewImage,
	);

	/**
	 * POST /api/share/download
	 * Получение изображения в высоком качестве для шэринга/скачивания
	 */
	router.post(
		'/download',
		validateInitData,
		userImageRateLimit.middleware(), // Применяем тот же лимит
		shareController.downloadImage,
	);

	/**
	 * GET /api/share/stats
	 * Получение статистики лимитов пользователя
	 */
	router.get(
		'/stats',
		validateInitData,
		async (req: any, res: any): Promise<any> => {
			try {
				const userId = (req as any).telegramUser?.id;

				if (!userId) {
					return res
						.status(400)
						.json({ error: 'Не удалось определить пользователя' });
				}

				const stats = await userImageRateLimit.getUserStats(userId.toString());
				res.json(stats);
			} catch (error) {
				console.error('Ошибка получения статистики:', error);
				res.status(500).json({ error: 'Ошибка получения статистики' });
			}
		},
	);

	return router;
};
