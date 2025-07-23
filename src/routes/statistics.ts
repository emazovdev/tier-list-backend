import express from 'express'
import {
	getPlayerRatings,
	saveGameResults,
} from '../controllers/statistics.controller'
import { initDataAuth } from '../middleware/validateInitData'

const router = express.Router()

// Сохранить результаты игры (любой пользователь)
router.post('/game-results', initDataAuth, saveGameResults)

// Получить рейтинги игроков по команде (только админы)
router.get('/ratings/:clubId', initDataAuth, getPlayerRatings)

export default router
