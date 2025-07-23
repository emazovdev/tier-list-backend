import { Request, Response, Router } from 'express'
import {
	addAdmin,
	addAdminByUsername,
	clearAllCache,
	clearAnalyticsCache,
	clearClubsCache,
	cleanupOrphanedStatistics,
	getAdmins,
	removeAdmin,
	searchUsers,
} from '../controllers/admin.controller'
import { checkAdminRole } from '../middleware/checkAdminRole'
import { userImageRateLimit } from '../middleware/userRateLimit'
import { initDataAuth } from '../middleware/validateInitData'
import { puppeteerPoolService } from '../services/puppeteerPool.service'

const router = Router()

// Все маршруты требуют валидации Telegram данных и роли админа
router.use(initDataAuth)
router.use(checkAdminRole)

// GET /api/admin/admins - получить список админов
router.get('/admins', getAdmins)

// POST /api/admin/admins - добавить нового админа
router.post('/admins', addAdmin)

// DELETE /api/admin/admins/:telegramId - удалить админа
router.delete('/admins/:telegramId', removeAdmin)

// GET /api/admin/search-users - поиск пользователей по username
router.get('/search-users', searchUsers)

// POST /api/admin/admins/by-username - добавить админа по username
router.post('/admins/by-username', addAdminByUsername)

// Маршруты для управления кешем
// DELETE /api/admin/cache/clubs - очистить кеш клубов и игроков
router.delete('/cache/clubs', clearClubsCache)

// DELETE /api/admin/cache/analytics - очистить кеш аналитики
router.delete('/cache/analytics', clearAnalyticsCache)

// DELETE /api/admin/cache/all - очистить весь кеш
router.delete('/cache/all', clearAllCache)

// Маршруты для очистки данных
// DELETE /api/admin/cleanup/orphaned-statistics - очистить потерянные статистики
router.delete('/cleanup/orphaned-statistics', cleanupOrphanedStatistics)

/**
 * POST /admin/reset-user-limits/:userId
 * Сброс лимитов генерации изображений для пользователя
 */
router.post(
	'/reset-user-limits/:userId',
	async (req: Request, res: Response): Promise<any> => {
		try {
			const { userId } = req.params

			if (!userId) {
				return res.status(400).json({ error: 'Не указан ID пользователя' })
			}

			await userImageRateLimit.resetUserLimits(userId)

			res.json({
				success: true,
				message: `Лимиты пользователя ${userId} сброшены`,
			})
		} catch (error) {
			console.error('Ошибка сброса лимитов пользователя:', error)
			res.status(500).json({ error: 'Ошибка сброса лимитов' })
		}
	}
)

/**
 * GET /admin/user-stats/:userId
 * Получение статистики лимитов пользователя (для админов)
 */
router.get(
	'/user-stats/:userId',
	initDataAuth,
	checkAdminRole,
	async (req: Request, res: Response): Promise<any> => {
		try {
			const { userId } = req.params

			if (!userId) {
				return res.status(400).json({ error: 'Не указан ID пользователя' })
			}

			const stats = await userImageRateLimit.getUserStats(userId)

			res.json({
				userId,
				stats,
			})
		} catch (error) {
			console.error('Ошибка получения статистики пользователя:', error)
			res.status(500).json({ error: 'Ошибка получения статистики' })
		}
	}
)

/**
 * GET /admin/puppeteer-metrics
 * Получение метрик пула браузеров Puppeteer
 */
router.get(
	'/puppeteer-metrics',
	initDataAuth,
	checkAdminRole,
	async (req: Request, res: Response): Promise<void> => {
		try {
			const metrics = puppeteerPoolService.getMetrics()

			res.json({
				success: true,
				metrics,
				timestamp: new Date().toISOString(),
			})
		} catch (error) {
			console.error('Ошибка получения метрик Puppeteer:', error)
			res.status(500).json({ error: 'Ошибка получения метрик' })
		}
	}
)

export default router
