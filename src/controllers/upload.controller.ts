import { Response, NextFunction } from 'express';
import { TelegramRequest } from '../types/api';
import { StorageService } from '../services/storage.service';
import { logger } from '../utils/logger';

const storageService = new StorageService();

/**
 * Генерирует presigned URL для прямой загрузки файла
 */
export const generateUploadUrl = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { fileName, contentType, folder } = req.body;

		if (!fileName || !contentType) {
			res.status(400).json({
				error: 'Имя файла и тип контента обязательны',
			});
			return;
		}

		// Проверяем тип файла
		const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

		if (!allowedTypes.includes(contentType)) {
			res.status(400).json({
				error: 'Неподдерживаемый тип файла',
			});
			return;
		}

		const { uploadUrl, fileKey } = await storageService.generateUploadUrl(
			fileName,
			contentType,
			folder || 'uploads',
		);

		res.json({
			ok: true,
			uploadUrl,
			fileKey,
		});
	} catch (error: any) {
		console.error('Ошибка генерации URL для загрузки:', error);
		res.status(500).json({
			error: 'Ошибка генерации ссылки для загрузки',
		});
	}
};

/**
 * Получает оптимизированные URL для множественных файлов
 */
export const getBatchImageUrls = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { fileKeys, width, height, format, quality } = req.body;

		if (!fileKeys || !Array.isArray(fileKeys)) {
			res.status(400).json({
				error: 'Список ключей файлов обязателен',
			});
			return;
		}

		const options = {
			width: width ? parseInt(width) : undefined,
			height: height ? parseInt(height) : undefined,
			format: format as 'webp' | 'jpeg' | 'png',
			quality: quality ? parseInt(quality) : undefined,
		};

		const urls = await storageService.getBatchUrls(fileKeys, options);

		res.json({
			ok: true,
			urls,
		});
	} catch (error: any) {
		console.error('Ошибка получения URL:', error);
		res.status(500).json({
			error: 'Ошибка получения ссылок на файлы',
		});
	}
};

/**
 * Получает статистику кэша изображений
 */
export const getCacheStats = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const stats = storageService.getCacheStats();

		res.json({
			ok: true,
			stats,
		});
	} catch (error: any) {
		console.error('Ошибка получения статистики кэша:', error);
		res.status(500).json({
			error: 'Ошибка получения статистики',
		});
	}
};

/**
 * Быстрое получение оптимизированных URL для изображений
 */
export const getFastImageUrls = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { fileKeys, type = 'avatar' } = req.body;

		if (!fileKeys || !Array.isArray(fileKeys)) {
			res.status(400).json({
				error: 'Список ключей файлов обязателен',
			});
			return;
		}

		if (!['avatar', 'logo'].includes(type)) {
			res.status(400).json({
				error: 'Тип изображения должен быть avatar или logo',
			});
			return;
		}

		const urls = await storageService.getBatchFastUrls(
			fileKeys,
			type as 'avatar' | 'logo',
		);

		res.json({
			ok: true,
			urls,
		});
	} catch (error: any) {
		console.error('Ошибка получения быстрых URL:', error);
		res.status(500).json({
			error: 'Ошибка получения ссылок на файлы',
		});
	}
};

export const getBatchUrls = async (
	req: TelegramRequest,
	res: Response,
): Promise<void> => {
	try {
		const { fileKeys, width, height, format = 'webp', quality = 80 } = req.body;

		// Валидация входных данных
		if (!Array.isArray(fileKeys) || fileKeys.length === 0) {
			res.status(400).json({
				ok: false,
				error: 'fileKeys должен быть непустым массивом',
			});
			return;
		}

		// Ограничиваем количество файлов в одном запросе
		if (fileKeys.length > 50) {
			res.status(400).json({
				ok: false,
				error: 'Максимальное количество файлов в одном запросе: 50',
			});
			return;
		}

		const storageService = new StorageService();

		// Измеряем время выполнения
		const startTime = Date.now();

		// Получаем URLs батчем для оптимизации
		const urls = await storageService.getBatchUrls(fileKeys, {
			width,
			height,
			format,
			quality,
		});

		// Логируем производительность
		const duration = Date.now() - startTime;
		if (duration > 200) {
			logger.warn(
				`Медленный batch-urls запрос: ${fileKeys.length} файлов за ${duration}ms`,
				'PERFORMANCE',
			);
		}

		res.json({
			ok: true,
			urls,
		});
	} catch (error) {
		logger.error('Ошибка при получении batch URLs', 'BATCH_URLS', error);
		res.status(500).json({
			ok: false,
			error: 'Внутренняя ошибка сервера',
		});
	}
};
