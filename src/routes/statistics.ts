import express from 'express'
import {
	getPlayerRatings,
	saveGameResults,
} from '../controllers/statistics.controller'
import { checkAdminRole } from '../middleware/checkAdminRole'
import { initDataAuth } from '../middleware/validateInitData'

const router = express.Router()

// Сохранить результаты игры (любой пользователь)
router.post('/game-results', initDataAuth, saveGameResults)

// Получить рейтинги игроков по команде (только админы)
router.get('/ratings/:clubId', initDataAuth, checkAdminRole, getPlayerRatings)

export default router
