import { prisma } from '../prisma';
import { convertBigIntToNumber } from '../utils/bigintUtils';

export enum EventType {
	APP_START = 'app_start',
	GAME_START = 'game_start',
	GAME_COMPLETED = 'game_completed',
	IMAGE_SHARED = 'image_shared',
}

export interface AnalyticsStats {
	totalUsers: number;
	totalAppStarts: number; // Общее количество запусков игр (GAME_START)
	totalGameCompletions: number;
	totalImageShares: number; // Общее количество поделенных картинок
	conversionRate: number;
	shareRate: number; // Процент пользователей, поделивших картинкой
	recentStats: {
		usersToday: number;
		appStartsToday: number; // Запуски игр за сегодня (GAME_START)
		gameCompletionsToday: number;
		imageSharesToday: number; // Количество поделенных картинок за сегодня
	};
}

export class AnalyticsService {
	/**
	 * Логирует событие пользователя (исключая админов)
	 */
	static async logEvent(
		telegramId: string,
		eventType: EventType,
		metadata?: any,
	): Promise<void> {
		try {
			// Проверяем роль пользователя - не логируем события от админов
			const user = await prisma.user.findUnique({
				where: { telegramId },
				select: { role: true },
			});

			if (user?.role === 'admin') {
				return;
			}

			await prisma.userEvent.create({
				data: {
					telegramId,
					eventType,
					metadata: metadata || {},
				},
			});
		} catch (error) {
			console.error('Ошибка при логировании события:', error);
			// Не прерываем основной поток при ошибке аналитики
		}
	}

	/**
	 * Начинает новую игровую сессию (исключая админов)
	 */
	static async startGameSession(
		telegramId: string,
		clubId: string,
	): Promise<string | null> {
		try {
			// Проверяем роль пользователя - не создаем сессии для админов
			const user = await prisma.user.findUnique({
				where: { telegramId },
				select: { role: true },
			});

			if (user?.role === 'admin') {
				return null;
			}

			// Проверяем, есть ли уже активная сессия
			const activeSession = await prisma.gameSession.findFirst({
				where: {
					telegramId,
					isCompleted: false,
				},
			});

			if (activeSession) {
				// НЕ завершаем предыдущую сессию автоматически
				// Возвращаем ID существующей активной сессии
				return activeSession.id;
			}

			// Создаем новую сессию только если нет активной
			const session = await prisma.gameSession.create({
				data: {
					telegramId,
					clubId,
				},
			});

			return session.id;
		} catch (error) {
			console.error('Ошибка при создании игровой сессии:', error);
			return null;
		}
	}

	/**
	 * Проверяет, нужно ли логировать APP_START для пользователя
	 */
	static async shouldLogAppStart(telegramId: string): Promise<boolean> {
		try {
			// Проверяем, есть ли APP_START событие за последние 24 часа
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);

			const recentAppStart = await prisma.userEvent.findFirst({
				where: {
					telegramId,
					eventType: EventType.APP_START,
					createdAt: {
						gte: yesterday,
					},
				},
			});

			return !recentAppStart; // Логируем только если нет APP_START за последние 24 часа
		} catch (error) {
			console.error('Ошибка при проверке APP_START:', error);
			return true; // В случае ошибки логируем
		}
	}

	/**
	 * Завершает активные сессии старше указанного времени
	 */
	static async expireOldSessions(hoursOld: number = 24): Promise<number> {
		try {
			const expireTime = new Date();
			expireTime.setHours(expireTime.getHours() - hoursOld);

			const result = await prisma.gameSession.updateMany({
				where: {
					isCompleted: false,
					startedAt: {
						lt: expireTime,
					},
				},
				data: {
					isCompleted: true,
					completedAt: new Date(),
				},
			});

			return result.count;
		} catch (error) {
			console.error('Ошибка при истечении старых сессий:', error);
			return 0;
		}
	}

	/**
	 * Принудительно завершает все активные сессии пользователя
	 */
	static async forceCompleteUserSessions(telegramId: string): Promise<number> {
		try {
			// Проверяем роль пользователя - не завершаем сессии для админов
			const user = await prisma.user.findUnique({
				where: { telegramId },
				select: { role: true },
			});

			if (user?.role === 'admin') {
				return 0;
			}

			const result = await prisma.gameSession.updateMany({
				where: {
					telegramId,
					isCompleted: false,
				},
				data: {
					isCompleted: true,
					completedAt: new Date(),
				},
			});

			return result.count;
		} catch (error) {
			console.error('Ошибка при принудительном завершении сессий:', error);
			return 0;
		}
	}

	/**
	 * Получает активную сессию пользователя
	 */
	static async getActiveSession(telegramId: string): Promise<any> {
		try {
			// Проверяем роль пользователя - не получаем сессии для админов
			const user = await prisma.user.findUnique({
				where: { telegramId },
				select: { role: true },
			});

			if (user?.role === 'admin') {
				return null;
			}

			const activeSession = await prisma.gameSession.findFirst({
				where: {
					telegramId,
					isCompleted: false,
				},
				orderBy: {
					startedAt: 'desc',
				},
			});

			return activeSession;
		} catch (error) {
			console.error('Ошибка при получении активной сессии:', error);
			return null;
		}
	}

	/**
	 * Завершает игровую сессию (исключая админов)
	 */
	static async completeGameSession(telegramId: string): Promise<void> {
		try {
			// Проверяем роль пользователя - не завершаем сессии для админов
			const user = await prisma.user.findUnique({
				where: { telegramId },
				select: { role: true },
			});

			if (user?.role === 'admin') {
				return;
			}

			// Находим активную сессию пользователя
			const activeSession = await prisma.gameSession.findFirst({
				where: {
					telegramId,
					isCompleted: false,
				},
			});

			if (activeSession) {
				await prisma.gameSession.update({
					where: { id: activeSession.id },
					data: {
						isCompleted: true,
						completedAt: new Date(),
					},
				});
			}
		} catch (error) {
			console.error('Ошибка при завершении игровой сессии:', error);
		}
	}

	/**
	 * Получает общую статистику (исключая админов)
	 */
	static async getStats(): Promise<AnalyticsStats> {
		try {
			// Общее количество уникальных пользователей (без админов)
			const totalUsers = await prisma.user.count({
				where: { role: 'user' },
			});

			// Общее количество запусков игр (от обычных пользователей)
			const totalAppStarts = await prisma.userEvent.count({
				where: {
					eventType: EventType.GAME_START,
					// Исключаем админов через join с таблицей users
					User: {
						role: 'user',
					},
				},
			});

			// Общее количество завершенных игр (от обычных пользователей)
			const totalGameCompletions = await prisma.gameSession.count({
				where: {
					isCompleted: true,
					// Исключаем админов через join с таблицей users
					User: {
						role: 'user',
					},
				},
			});

			// Общее количество поделенных картинок (от обычных пользователей)
			const totalImageShares = await prisma.userEvent.count({
				where: {
					eventType: EventType.IMAGE_SHARED,
					// Исключаем админов через join с таблицей users
					User: {
						role: 'user',
					},
				},
			});

			// Конверсия
			const conversionRate =
				totalAppStarts > 0 ? (totalGameCompletions / totalAppStarts) * 100 : 0;

			// Процент пользователей, поделивших картинкой
			const shareRate =
				totalGameCompletions > 0
					? (totalImageShares / totalGameCompletions) * 100
					: 0;

			// Статистика за сегодня
			const todayStart = new Date();
			todayStart.setHours(0, 0, 0, 0);
			const todayEnd = new Date();
			todayEnd.setHours(23, 59, 59, 999);

			const usersToday = await prisma.user.count({
				where: {
					role: 'user',
					createdAt: {
						gte: todayStart,
						lte: todayEnd,
					},
				},
			});

			const appStartsToday = await prisma.userEvent.count({
				where: {
					eventType: EventType.GAME_START,
					User: {
						role: 'user',
					},
					createdAt: {
						gte: todayStart,
						lte: todayEnd,
					},
				},
			});

			const gameCompletionsToday = await prisma.gameSession.count({
				where: {
					isCompleted: true,
					User: {
						role: 'user',
					},
					completedAt: {
						gte: todayStart,
						lte: todayEnd,
					},
				},
			});

			const imageSharesToday = await prisma.userEvent.count({
				where: {
					eventType: EventType.IMAGE_SHARED,
					User: {
						role: 'user',
					},
					createdAt: {
						gte: todayStart,
						lte: todayEnd,
					},
				},
			});

			// Преобразуем все BigInt значения в Number
			const result = {
				totalUsers,
				totalAppStarts,
				totalGameCompletions,
				totalImageShares,
				conversionRate: Math.round(conversionRate * 100) / 100,
				shareRate: Math.round(shareRate * 100) / 100,
				recentStats: {
					usersToday,
					appStartsToday,
					gameCompletionsToday,
					imageSharesToday,
				},
			};

			return convertBigIntToNumber(result);
		} catch (error) {
			console.error('Ошибка при получении статистики:', error);
			throw new Error('Ошибка при получении статистики');
		}
	}

	/**
	 * Получает детальную статистику по периодам (исключая админов)
	 */
	static async getDetailedStats(days: number = 7): Promise<any> {
		try {
			const endDate = new Date();
			const startDate = new Date();
			startDate.setDate(startDate.getDate() - days);

			// Статистика по дням (исключая админов)
			const dailyStatsRaw = await prisma.$queryRaw`
				SELECT 
					DATE(ue.created_at) as date,
					COUNT(CASE WHEN ue.event_type = 'game_start' THEN 1 END) as app_starts,
					COUNT(CASE WHEN ue.event_type = 'game_completed' THEN 1 END) as game_completions,
					COUNT(CASE WHEN ue.event_type = 'image_shared' THEN 1 END) as image_shares
				FROM user_events ue
				INNER JOIN users u ON ue.telegram_id = u.telegram_id
				WHERE ue.created_at >= ${startDate} 
					AND ue.created_at <= ${endDate}
					AND u.role = 'user'
				GROUP BY DATE(ue.created_at)
				ORDER BY DATE(ue.created_at) DESC
			`;

			// Преобразуем BigInt в Number и обрабатываем даты
			const dailyStats = convertBigIntToNumber(dailyStatsRaw);

			// Топ клубов по количеству игр (исключая админов)
			const topClubsRaw = await prisma.gameSession.groupBy({
				by: ['clubId'],
				where: {
					isCompleted: true,
					clubId: {
						not: null, // Исключаем сессии с удаленными клубами
					},
					completedAt: {
						gte: startDate,
						lte: endDate,
					},
					// Исключаем админов
					User: {
						role: 'user',
					},
				},
				_count: {
					id: true,
				},
				orderBy: {
					_count: {
						id: 'desc',
					},
				},
				take: 5,
			});

			// Преобразуем BigInt в Number для топ клубов
			const topClubs = convertBigIntToNumber(topClubsRaw);

			// Получаем названия клубов
			const clubIds = topClubs.map((club: any) => club.clubId).filter(Boolean);
			const clubs = await prisma.club.findMany({
				where: {
					id: {
						in: clubIds as string[],
					},
				},
				select: {
					id: true,
					name: true,
				},
			});

			const topClubsWithNames = topClubs.map((stat: any) => ({
				clubId: stat.clubId,
				clubName:
					clubs.find((club) => club.id === stat.clubId)?.name ||
					'Неизвестный клуб',
				gameCount: stat._count.id,
			}));

			return {
				dailyStats,
				topClubs: topClubsWithNames,
			};
		} catch (error) {
			console.error('Ошибка при получении детальной статистики:', error);
			throw new Error('Ошибка при получении детальной статистики');
		}
	}

	/**
	 * Сбрасывает всю аналитику (только для суперадминов)
	 * Очищает таблицы user_events, game_sessions и удаляет обычных пользователей
	 */
	static async resetAnalytics(): Promise<{
		deletedUserEvents: number;
		deletedGameSessions: number;
		deletedUsers: number;
	}> {
		try {
			// Подсчитываем количество записей перед удалением для отчета
			const userEventsCount = await prisma.userEvent.count();
			const gameSessionsCount = await prisma.gameSession.count();
			const usersCount = await prisma.user.count({
				where: { role: 'user' },
			});

			console.log(
				`Найдено записей для удаления: ${userEventsCount} событий, ${gameSessionsCount} сессий, ${usersCount} пользователей`,
			);

			// Выполняем операции удаления в транзакции
			const result = await prisma.$transaction(async (tx) => {
				// 1. Удаляем все события пользователей
				await tx.userEvent.deleteMany({});
				console.log('Все события пользователей удалены');

				// 2. Удаляем все игровые сессии
				await tx.gameSession.deleteMany({});
				console.log('Все игровые сессии удалены');

				// 3. Удаляем всех обычных пользователей (сохраняем только админов)
				await tx.user.deleteMany({
					where: {
						role: 'user',
					},
				});
				console.log('Все обычные пользователи удалены');

				return {
					deletedUserEvents: userEventsCount,
					deletedGameSessions: gameSessionsCount,
					deletedUsers: usersCount,
				};
			});

			console.log('Сброс аналитики завершен успешно');
			return result;
		} catch (error) {
			console.error('Ошибка при сбросе аналитики:', error);
			throw new Error('Ошибка при сбросе аналитики');
		}
	}
}
