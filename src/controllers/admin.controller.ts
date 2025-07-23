import { NextFunction, Response } from 'express'
import { invalidateAllAdminCache } from '../middleware/checkAdminRole'
import { prisma } from '../prisma'
import { AdminService } from '../services/admin.service'
import { redisService } from '../services/redis.service'
import { TelegramRequest } from '../types/api'
import {
	invalidateAllDataCache,
	invalidateAnalyticsCache,
	invalidateClubsCache,
} from '../utils/cacheUtils'

/**
 * Получить список всех админов
 */
export const getAdmins = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const admins = await AdminService.getAdmins()
		res.json({ ok: true, admins })
	} catch (error) {
		console.error('Ошибка при получении списка админов:', error)
		res.status(500).json({ error: 'Ошибка сервера' })
	}
}

/**
 * Добавить нового админа
 */
export const addAdmin = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const { telegramUser } = req.body
		const { telegramId, username } = req.body

		if (!telegramId) {
			res.status(400).json({ error: 'telegram_id обязателен' })
			return
		}

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' })
			return
		}

		const addedBy = telegramUser.id.toString()
		const result = await AdminService.addAdmin(
			telegramId,
			username || null,
			addedBy
		)

		if (result.success) {
			// ИСПРАВЛЕНИЕ: AdminService уже инвалидирует конкретный кэш админа,
			// здесь мы инвалидируем общие кэши данных
			await invalidateAllDataCache()
			res.json({ ok: true, message: result.message })
		} else {
			res.status(400).json({ error: result.message })
		}
	} catch (error) {
		console.error('Ошибка при добавлении админа:', error)
		res.status(500).json({ error: 'Ошибка сервера' })
	}
}

/**
 * Удалить админа
 */
export const removeAdmin = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const { telegramUser } = req.body
		const { telegramId } = req.params

		if (!telegramId) {
			res.status(400).json({ error: 'telegram_id обязателен' })
			return
		}

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' })
			return
		}

		const removedBy = telegramUser.id.toString()
		const result = await AdminService.removeAdmin(telegramId, removedBy)

		if (result.success) {
			// ИСПРАВЛЕНИЕ: AdminService уже инвалидирует конкретный кэш админа,
			// здесь мы инвалидируем общие кэши данных
			await invalidateAllDataCache()
			res.json({ ok: true, message: result.message })
		} else {
			res.status(400).json({ error: result.message })
		}
	} catch (error) {
		console.error('Ошибка при удалении админа:', error)
		res.status(500).json({ error: 'Ошибка сервера' })
	}
}

/**
 * Поиск пользователей по username
 */
export const searchUsers = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const { telegramUser } = req.body
		const { query } = req.query

		if (!query || typeof query !== 'string') {
			res.status(400).json({ error: 'Параметр query обязателен' })
			return
		}

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' })
			return
		}

		const requestedBy = telegramUser.id.toString()
		const result = await AdminService.searchUsersByUsername(query, requestedBy)

		if (result.success) {
			res.json({ ok: true, users: result.users })
		} else {
			res.status(400).json({ error: result.message })
		}
	} catch (error) {
		console.error('Ошибка при поиске пользователей:', error)
		res.status(500).json({ error: 'Ошибка сервера' })
	}
}

/**
 * Добавить админа по username
 */
export const addAdminByUsername = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const { telegramUser } = req.body
		const { username } = req.body

		if (!username) {
			res.status(400).json({ error: 'username обязателен' })
			return
		}

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' })
			return
		}

		const addedBy = telegramUser.id.toString()
		const result = await AdminService.addAdminByUsername(username, addedBy)

		if (result.success) {
			// ИСПРАВЛЕНИЕ: AdminService уже инвалидирует конкретный кэш админа,
			// здесь мы инвалидируем общие кэши данных
			await invalidateAllDataCache()
			res.json({ ok: true, message: result.message })
		} else {
			res.status(400).json({ error: result.message })
		}
	} catch (error) {
		console.error('Ошибка при добавлении админа по username:', error)
		res.status(500).json({ error: 'Ошибка сервера' })
	}
}

/**
 * Очистить весь кеш клубов и игроков (только для админов)
 */
export const clearClubsCache = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		await invalidateClubsCache()

		res.json({
			ok: true,
			message: 'Кеш клубов и игроков успешно очищен',
		})
	} catch (error) {
		console.error('Ошибка при очистке кеша клубов:', error)
		res.status(500).json({ error: 'Ошибка при очистке кеша' })
	}
}

/**
 * Очистить потерянные записи статистики (только для админов)
 * Удаляет статистики для несуществующих игроков или команд
 */
export const cleanupOrphanedStatistics = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		console.log('🧹 Начинаем очистку потерянных записей статистики...')

		let totalDeletedStats = 0

		await prisma.$transaction(async (tx: any) => {
			// 1. Находим статистики с несуществующими игроками
			const orphanedByPlayers = await tx.playerStatistics.findMany({
				where: {
					player: null,
				},
				select: {
					id: true,
					playerId: true,
					categoryName: true,
				},
			})

			if (orphanedByPlayers.length > 0) {
				console.log(
					`🗑️ Найдено ${orphanedByPlayers.length} статистик с несуществующими игроками`
				)

				const deletedByPlayers = await tx.playerStatistics.deleteMany({
					where: {
						id: {
							in: orphanedByPlayers.map((stat: any) => stat.id),
						},
					},
				})

				console.log(
					`✅ Удалено ${deletedByPlayers.count} статистик с несуществующими игроками`
				)
				totalDeletedStats += deletedByPlayers.count
			}

			// 2. Находим статистики с несуществующими командами
			const orphanedByClubs = await tx.playerStatistics.findMany({
				where: {
					club: null,
				},
				select: {
					id: true,
					clubId: true,
					categoryName: true,
				},
			})

			if (orphanedByClubs.length > 0) {
				console.log(
					`🗑️ Найдено ${orphanedByClubs.length} статистик с несуществующими командами`
				)

				const deletedByClubs = await tx.playerStatistics.deleteMany({
					where: {
						id: {
							in: orphanedByClubs.map((stat: any) => stat.id),
						},
					},
				})

				console.log(
					`✅ Удалено ${deletedByClubs.count} статистик с несуществующими командами`
				)
				totalDeletedStats += deletedByClubs.count
			}

			// 3. Альтернативный подход: проверяем через NOT EXISTS
			const orphanedStatsAlternative = (await tx.$queryRaw`
				SELECT ps.id, ps.player_id, ps.club_id, ps.category_name
				FROM player_statistics ps
				LEFT JOIN players p ON ps.player_id = p.id
				LEFT JOIN clubs c ON ps.club_id = c.id
				WHERE p.id IS NULL OR c.id IS NULL
			`) as Array<{
				id: string
				player_id: string
				club_id: string
				category_name: string
			}>

			if (orphanedStatsAlternative.length > 0) {
				console.log(
					`🗑️ Альтернативная проверка: найдено ${orphanedStatsAlternative.length} потерянных статистик`
				)

				const deletedAlternative = await tx.playerStatistics.deleteMany({
					where: {
						id: {
							in: orphanedStatsAlternative.map((stat: any) => stat.id),
						},
					},
				})

				console.log(
					`✅ Альтернативная проверка: удалено ${deletedAlternative.count} потерянных статистик`
				)
				totalDeletedStats += deletedAlternative.count
			}
		})

		// Очищаем кэш после очистки данных
		await invalidateClubsCache()
		console.log('🔄 Кэш очищен после удаления потерянных статистик')

		console.log(
			`✅ Очистка завершена. Всего удалено ${totalDeletedStats} потерянных записей статистики`
		)

		res.json({
			ok: true,
			message: 'Потерянные записи статистики успешно очищены',
			deletedCount: totalDeletedStats,
		})
	} catch (error) {
		console.error('❌ Ошибка при очистке потерянных статистик:', error)
		res.status(500).json({
			error: 'Ошибка при очистке потерянных статистик',
			details: (error as Error).message,
		})
	}
}

/**
 * Очистить весь кеш аналитики (только для админов)
 */
export const clearAnalyticsCache = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		await invalidateAnalyticsCache()

		res.json({
			ok: true,
			message: 'Кеш аналитики успешно очищен',
		})
	} catch (error) {
		console.error('Ошибка при очистке кеша аналитики:', error)
		res.status(500).json({ error: 'Ошибка при очистке кеша' })
	}
}

/**
 * Очистить весь кеш (только для админов)
 */
export const clearAllCache = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Очищаем все типы кэша включая админский
		await Promise.all([
			redisService.flushAll(),
			invalidateAllAdminCache(), // Дополнительно очищаем админский кэш
		])

		res.json({
			ok: true,
			message: 'Весь кеш включая админский успешно очищен',
		})
	} catch (error) {
		console.error('Ошибка при полной очистке кеша:', error)
		res.status(500).json({ error: 'Ошибка при очистке кеша' })
	}
}
