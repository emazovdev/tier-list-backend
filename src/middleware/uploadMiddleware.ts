import multer from 'multer';
import path from 'path';
import { Request } from 'express';
import crypto from 'crypto';

// Настройка хранилища для multer
const storage = multer.diskStorage({
	// Временная директория для хранения файлов перед отправкой в R2
	destination: (req, file, cb) => {
		cb(null, path.join(process.cwd(), 'tmp/uploads'));
	},
	// Генерируем уникальное имя файла
	filename: (req, file, cb) => {
		const randomName = crypto.randomBytes(16).toString('hex');
		const fileExt = path.extname(file.originalname);
		cb(null, `${randomName}${fileExt}`);
	},
});

// Фильтр для проверки типа файла (только изображения)
const fileFilter = (
	req: Request,
	file: Express.Multer.File,
	cb: multer.FileFilterCallback,
) => {
	const allowedMimeTypes = [
		'image/jpeg',
		'image/png',
		'image/webp',
		'image/gif',
	];

	if (allowedMimeTypes.includes(file.mimetype)) {
		cb(null, true);
	} else {
		cb(
			new Error(
				'Неподдерживаемый формат файла. Разрешены только изображения (JPEG, PNG, WebP, GIF)',
			),
		);
	}
};

// ОПТИМИЗАЦИЯ: Более строгие лимиты для лучшей производительности
const limits = {
	fileSize: 5 * 1024 * 1024, // 5MB максимум
	files: 1, // Только один файл за раз
	fields: 10, // Максимум полей в форме
	fieldSize: 1024 * 1024, // 1MB на поле
};

// Настройка multer для загрузки клубов
export const uploadClubLogo = multer({
	storage,
	fileFilter,
	limits,
}).single('logo');

// Настройка multer для загрузки аватаров игроков
export const uploadPlayerAvatar = multer({
	storage,
	fileFilter,
	limits,
}).single('avatar');

// ОПТИМИЗАЦИЯ: Более быстрая обработка ошибок
export const handleUploadError = (
	error: any,
	req: any,
	res: any,
	next: any,
) => {
	if (error instanceof multer.MulterError) {
		switch (error.code) {
			case 'LIMIT_FILE_SIZE':
				return res.status(400).json({
					error: 'Файл слишком большой. Максимальный размер: 5MB',
				});
			case 'LIMIT_FILE_COUNT':
				return res.status(400).json({
					error: 'Можно загружать только один файл за раз',
				});
			case 'LIMIT_UNEXPECTED_FILE':
				return res.status(400).json({
					error: 'Неожиданный файл в запросе',
				});
			default:
				return res.status(400).json({
					error: 'Ошибка загрузки файла',
				});
		}
	}

	if (error.message.includes('Неподдерживаемый формат файла')) {
		return res.status(400).json({
			error: error.message,
		});
	}

	// Логируем неизвестные ошибки
	console.error('Неизвестная ошибка загрузки:', error);
	return res.status(500).json({
		error: 'Внутренняя ошибка сервера при загрузке файла',
	});
};
