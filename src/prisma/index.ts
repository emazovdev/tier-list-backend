import { PrismaClient } from '../../generated/prisma';
import { logger } from '../utils/logger';

/**
 * Оптимизированная конфигурация Prisma для высоких нагрузок
 */
export const prisma = new PrismaClient({
	// Настройки логирования для мониторинга
	log: [
		{ emit: 'event', level: 'query' },
		{ emit: 'event', level: 'error' },
		{ emit: 'event', level: 'warn' },
	],

	// Настройки подключения для высоких нагрузок
	datasources: {
		db: {
			url: process.env.DATABASE_URL,
		},
	},
});

// Мониторинг медленных запросов
prisma.$on('query', (e) => {
	const duration = e.duration;
	if (duration > 1000) {
		// Запросы дольше 1 секунды
		logger.warn(
			`Медленный SQL запрос: ${e.query.substring(0, 100)}... - ${duration}ms`,
			'DATABASE',
		);
	}
});

// Логирование ошибок БД
prisma.$on('error', (e) => {
	logger.error('Ошибка базы данных:', 'DATABASE', e);
});

prisma.$on('warn', (e) => {
	logger.warn('Предупреждение базы данных:', 'DATABASE');
});

// Graceful shutdown для корректного закрытия соединений
process.on('beforeExit', async () => {
	logger.info('Закрытие соединений с базой данных...', 'DATABASE');
	await prisma.$disconnect();
});

// Проверка подключения при старте
prisma
	.$connect()
	.then(() => {
		logger.info('Подключение к базе данных установлено', 'DATABASE');
	})
	.catch((error) => {
		logger.error('Ошибка подключения к базе данных:', 'DATABASE', error);
		process.exit(1);
	});
