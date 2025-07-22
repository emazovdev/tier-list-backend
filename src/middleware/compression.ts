import { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';

/**
 * Простая реализация сжатия ответов
 * Примечание: для production рекомендуется использовать пакет compression
 */
export const simpleCompression = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Получаем заголовок Accept-Encoding
	const acceptEncoding = (req.headers['accept-encoding'] as string) || '';

	// Сохраняем оригинальный метод res.end
	const originalEnd = res.end;

	// Определяем поддерживаемые методы сжатия
	const supportsGzip = acceptEncoding.includes('gzip');
	const supportsDeflate = acceptEncoding.includes('deflate');

	// Если клиент не поддерживает сжатие, пропускаем
	if (!supportsGzip && !supportsDeflate) {
		next();
		return;
	}

	// Устанавливаем минимальный размер для сжатия (1KB)
	const MIN_SIZE_TO_COMPRESS = 1024;

	// Переопределяем метод res.end для сжатия данных
	// @ts-ignore
	res.end = function (
		chunk: any,
		encoding: BufferEncoding,
		callback?: () => void,
	) {
		// Если данных нет или они слишком маленькие, не сжимаем
		if (
			!chunk ||
			(Buffer.isBuffer(chunk) && chunk.length < MIN_SIZE_TO_COMPRESS)
		) {
			// @ts-ignore
			return originalEnd.apply(res, arguments);
		}

		// Конвертируем chunk в Buffer, если это не Buffer
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: Buffer.from(chunk, encoding as BufferEncoding);

		// Если размер данных меньше минимального, не сжимаем
		if (buffer.length < MIN_SIZE_TO_COMPRESS) {
			// @ts-ignore
			return originalEnd.apply(res, arguments);
		}

		// Выбираем метод сжатия
		if (supportsGzip) {
			// Сжимаем с помощью gzip
			zlib.gzip(buffer, (err, result) => {
				if (err) {
					// В случае ошибки, отправляем без сжатия
					// @ts-ignore
					return originalEnd.apply(res, arguments);
				}

				// Устанавливаем заголовки
				res.setHeader('Content-Encoding', 'gzip');
				res.setHeader('Content-Length', result.length);
				res.setHeader('Vary', 'Accept-Encoding');

				// Отправляем сжатые данные
				// @ts-ignore
				originalEnd.call(res, result);
			});
		} else if (supportsDeflate) {
			// Сжимаем с помощью deflate
			zlib.deflate(buffer, (err, result) => {
				if (err) {
					// В случае ошибки, отправляем без сжатия
					// @ts-ignore
					return originalEnd.apply(res, arguments);
				}

				// Устанавливаем заголовки
				res.setHeader('Content-Encoding', 'deflate');
				res.setHeader('Content-Length', result.length);
				res.setHeader('Vary', 'Accept-Encoding');

				// Отправляем сжатые данные
				// @ts-ignore
				originalEnd.call(res, result);
			});
		} else {
			// Если не поддерживается ни один метод сжатия, отправляем без сжатия
			// @ts-ignore
			return originalEnd.apply(res, arguments);
		}
	};

	next();
};
