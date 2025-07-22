enum LogLevel {
	ERROR = 'error',
	WARN = 'warn',
	INFO = 'info',
	DEBUG = 'debug',
}

interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
	context?: string;
	error?: any;
}

// Критически важные контексты для production
const CRITICAL_CONTEXTS = [
	'AUTH',
	'DATABASE',
	'TELEGRAM_BOT',
	'IMAGE_GENERATION',
	'STARTUP',
	'SHUTDOWN',
	'RATE_LIMIT',
	'CACHE',
];

// Ключевые слова для важных событий
const IMPORTANT_KEYWORDS = [
	'ошибка',
	'error',
	'авторизация',
	'auth',
	'изображение сгенерировано',
	'изображение отправлено',
	'генерация провалена',
	'превышен лимит',
	'запущен',
	'остановлен',
	'подключение',
	'отключение',
];

class Logger {
	private isProduction = process.env.NODE_ENV === 'production';
	private shouldLogDebug = process.env.DEBUG === 'true';

	private isImportantMessage(message: string, context?: string): boolean {
		// В development показываем все
		if (!this.isProduction) return true;

		// Критически важные контексты всегда логируем
		if (context && CRITICAL_CONTEXTS.includes(context)) return true;

		// Проверяем ключевые слова
		const lowerMessage = message.toLowerCase();
		return IMPORTANT_KEYWORDS.some((keyword) => lowerMessage.includes(keyword));
	}

	private formatLog(entry: LogEntry): string {
		const { level, message, timestamp, context, error } = entry;

		if (this.isProduction) {
			// Краткий JSON формат для production
			return JSON.stringify({
				level,
				message: this.truncateMessage(message),
				timestamp,
				context,
				...(error && { error: this.truncateMessage(error.message) }),
			});
		} else {
			// Читаемый формат для development
			const prefix = context ? `[${context}]` : '';
			return `${timestamp} ${level.toUpperCase()} ${prefix} ${message}${
				error ? ` - ${error.message}` : ''
			}`;
		}
	}

	private truncateMessage(message: string, maxLength: number = 200): string {
		if (message.length <= maxLength) return message;
		return message.substring(0, maxLength) + '...';
	}

	private log(level: LogLevel, message: string, context?: string, error?: any) {
		// В production фильтруем неважные сообщения
		if (this.isProduction && !this.isImportantMessage(message, context)) {
			return;
		}

		// Debug логи только при включенном флаге
		if (level === LogLevel.DEBUG && !this.shouldLogDebug) {
			return;
		}

		const entry: LogEntry = {
			level,
			message,
			timestamp: new Date().toISOString(),
			context,
			error,
		};

		const formattedLog = this.formatLog(entry);

		switch (level) {
			case LogLevel.ERROR:
				console.error(formattedLog);
				break;
			case LogLevel.WARN:
				console.warn(formattedLog);
				break;
			case LogLevel.INFO:
				console.log(formattedLog);
				break;
			case LogLevel.DEBUG:
				console.debug(formattedLog);
				break;
		}
	}

	error(message: string, context?: string, error?: any) {
		this.log(LogLevel.ERROR, message, context, error);
	}

	warn(message: string, context?: string) {
		this.log(LogLevel.WARN, message, context);
	}

	info(message: string, context?: string) {
		this.log(LogLevel.INFO, message, context);
	}

	debug(message: string, context?: string) {
		this.log(LogLevel.DEBUG, message, context);
	}

	// Специальные методы для критически важных событий
	startup(message: string) {
		this.info(`🚀 ${message}`, 'STARTUP');
	}

	shutdown(message: string) {
		this.info(`🔻 ${message}`, 'SHUTDOWN');
	}

	auth(message: string, userId?: string) {
		this.info(`🔐 ${message}${userId ? ` (User: ${userId})` : ''}`, 'AUTH');
	}

	imageGenerated(success: boolean, userId?: string, duration?: number) {
		const status = success
			? '✅ Изображение сгенерировано'
			: '❌ Генерация провалена';
		const extra = duration ? ` за ${duration}ms` : '';
		const user = userId ? ` (User: ${userId})` : '';
		this.info(`${status}${extra}${user}`, 'IMAGE_GENERATION');
	}

	imageSent(success: boolean, userId?: string, size?: number) {
		const status = success
			? '📤 Изображение отправлено'
			: '❌ Отправка провалена';
		const sizeInfo = size ? ` (${(size / 1024 / 1024).toFixed(2)}MB)` : '';
		const user = userId ? ` (User: ${userId})` : '';
		this.info(`${status}${sizeInfo}${user}`, 'TELEGRAM_BOT');
	}

	rateLimitHit(ip: string, endpoint: string, limit: number) {
		this.warn(
			`🚫 Rate limit превышен: ${ip} на ${endpoint} (лимит: ${limit})`,
			'RATE_LIMIT',
		);
	}

	performance(message: string, duration?: number) {
		// Логируем только медленные операции
		if (duration && duration > 1000) {
			this.warn(
				`⚠️ Медленная операция: ${message} (${duration}ms)`,
				'PERFORMANCE',
			);
		}
	}

	// Метод для очистки verbose логов генерации изображений
	silentImageProcess(message: string) {
		// В production не логируем технические детали генерации
		if (!this.isProduction) {
			this.debug(message, 'IMAGE_WORKER');
		}
	}
}

export const logger = new Logger();
