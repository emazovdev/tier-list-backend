import { Request, Response, NextFunction } from 'express';

/**
 * Обработчик ошибок приложения
 */
export class AppError extends Error {
	statusCode: number;

	constructor(message: string, statusCode: number = 500) {
		super(message);
		this.statusCode = statusCode;
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Middleware для обработки ошибок
 */
export const errorHandler = (
	err: Error | AppError,
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	console.error(err.stack);

	const statusCode = 'statusCode' in err ? err.statusCode : 500;
	const message = err.message || 'Внутренняя ошибка сервера';

	res.status(statusCode).json({
		error: message,
	});
};
