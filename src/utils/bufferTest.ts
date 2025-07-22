/**
 * Утилита для тестирования конвертации Buffer → base64 → Buffer
 * Помогает диагностировать проблемы с изображениями
 */

import { logger } from './logger';

export function testBufferConversion(
	originalBuffer: Buffer,
	description: string = 'Buffer',
): boolean {
	try {
		logger.info(
			`🧪 Начало теста конвертации для ${description}`,
			'BUFFER_TEST',
		);

		// Проверяем исходный Buffer
		if (!Buffer.isBuffer(originalBuffer)) {
			logger.error(
				`❌ Исходный объект не является Buffer: ${typeof originalBuffer}`,
				'BUFFER_TEST',
			);
			return false;
		}

		if (originalBuffer.length === 0) {
			logger.error(`❌ Исходный Buffer пустой`, 'BUFFER_TEST');
			return false;
		}

		// Проверяем JPEG заголовок в исходном Buffer
		const originalHeader = originalBuffer.subarray(0, 3);
		const originalIsValidJPEG =
			originalHeader[0] === 0xff &&
			originalHeader[1] === 0xd8 &&
			originalHeader[2] === 0xff;

		logger.info(
			`📋 Исходный Buffer: размер=${
				originalBuffer.length
			}, JPEG=${originalIsValidJPEG}, заголовок=${originalHeader.toString(
				'hex',
			)}`,
			'BUFFER_TEST',
		);

		// Конвертируем в base64
		const base64String = originalBuffer.toString('base64');

		if (!base64String || base64String.length === 0) {
			logger.error(`❌ Конвертация в base64 дала пустую строку`, 'BUFFER_TEST');
			return false;
		}

		logger.info(`📋 Base64: длина=${base64String.length}`, 'BUFFER_TEST');

		// Конвертируем обратно в Buffer
		const convertedBuffer = Buffer.from(base64String, 'base64');

		if (!Buffer.isBuffer(convertedBuffer)) {
			logger.error(
				`❌ Результат конвертации не является Buffer`,
				'BUFFER_TEST',
			);
			return false;
		}

		if (convertedBuffer.length === 0) {
			logger.error(`❌ Конвертированный Buffer пустой`, 'BUFFER_TEST');
			return false;
		}

		// Сравниваем размеры
		if (originalBuffer.length !== convertedBuffer.length) {
			logger.error(
				`❌ Размеры Buffer не совпадают: исходный=${originalBuffer.length}, конвертированный=${convertedBuffer.length}`,
				'BUFFER_TEST',
			);
			return false;
		}

		// Проверяем JPEG заголовок в конвертированном Buffer
		const convertedHeader = convertedBuffer.subarray(0, 3);
		const convertedIsValidJPEG =
			convertedHeader[0] === 0xff &&
			convertedHeader[1] === 0xd8 &&
			convertedHeader[2] === 0xff;

		logger.info(
			`📋 Конвертированный Buffer: размер=${
				convertedBuffer.length
			}, JPEG=${convertedIsValidJPEG}, заголовок=${convertedHeader.toString(
				'hex',
			)}`,
			'BUFFER_TEST',
		);

		// Проверяем побайтовое соответствие
		const areEqual = originalBuffer.equals(convertedBuffer);

		if (!areEqual) {
			logger.error(
				`❌ Содержимое Buffer изменилось при конвертации`,
				'BUFFER_TEST',
			);

			// Найдем первое отличие
			for (
				let i = 0;
				i < Math.min(originalBuffer.length, convertedBuffer.length);
				i++
			) {
				if (originalBuffer[i] !== convertedBuffer[i]) {
					logger.error(
						`❌ Первое отличие на позиции ${i}: исходный=0x${originalBuffer[
							i
						].toString(16)}, конвертированный=0x${convertedBuffer[i].toString(
							16,
						)}`,
						'BUFFER_TEST',
					);
					break;
				}
			}
			return false;
		}

		// Дополнительная проверка - конвертируем обратно в base64 и сравниваем
		const verificationBase64 = convertedBuffer.toString('base64');

		if (base64String !== verificationBase64) {
			logger.error(
				`❌ Base64 строки не совпадают при повторной конвертации`,
				'BUFFER_TEST',
			);
			return false;
		}

		logger.info(
			`✅ Тест конвертации успешно пройден для ${description}`,
			'BUFFER_TEST',
		);
		return true;
	} catch (error) {
		logger.error(
			`❌ Ошибка при тестировании конвертации ${description}:`,
			'BUFFER_TEST',
			error as Error,
		);
		return false;
	}
}

/**
 * Расширенная диагностика Buffer для отладки
 */
export function diagnoseBuffer(
	buffer: any,
	description: string = 'Buffer',
): void {
	logger.info(`🔍 Диагностика ${description}:`, 'BUFFER_DIAG');

	logger.info(`  - Существует: ${!!buffer}`, 'BUFFER_DIAG');
	logger.info(`  - Тип: ${typeof buffer}`, 'BUFFER_DIAG');
	logger.info(
		`  - Конструктор: ${buffer?.constructor?.name || 'undefined'}`,
		'BUFFER_DIAG',
	);
	logger.info(`  - Является Buffer: ${Buffer.isBuffer(buffer)}`, 'BUFFER_DIAG');

	if (buffer && typeof buffer === 'object') {
		logger.info(`  - Длина: ${buffer.length || 'undefined'}`, 'BUFFER_DIAG');

		if (Buffer.isBuffer(buffer) && buffer.length > 0) {
			const header = buffer.subarray(0, Math.min(10, buffer.length));
			logger.info(`  - Первые байты: ${header.toString('hex')}`, 'BUFFER_DIAG');

			const isJPEG =
				buffer.length >= 3 &&
				buffer[0] === 0xff &&
				buffer[1] === 0xd8 &&
				buffer[2] === 0xff;
			logger.info(`  - JPEG заголовок: ${isJPEG}`, 'BUFFER_DIAG');
		}
	}
}
