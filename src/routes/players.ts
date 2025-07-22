import { Router } from 'express';
import { initDataAuth } from '../middleware/validateInitData';
import { checkAdminRole } from '../middleware/checkAdminRole';
import {
	uploadPlayerAvatar,
	handleUploadError,
} from '../middleware/uploadMiddleware';

import {
	createPlayer,
	deletePlayer,
	getAllPlayers,
	getPlayerById,
	updatePlayer,
} from '../controllers/players.controller';

const router = Router();

// Создание игрока - только для админа с загрузкой аватара
router.post(
	'/',
	initDataAuth,
	checkAdminRole,
	uploadPlayerAvatar,
	handleUploadError,
	createPlayer,
);

// Получение списка всех игроков
router.get('/', initDataAuth, getAllPlayers);

// Получение информации об игроке по ID
router.get('/:id', initDataAuth, getPlayerById);

// Обновление игрока - только для админа с загрузкой аватара
router.put(
	'/:id',
	initDataAuth,
	checkAdminRole,
	uploadPlayerAvatar,
	handleUploadError,
	updatePlayer,
);

// Удаление игрока - только для админа
router.delete('/:id', initDataAuth, checkAdminRole, deletePlayer);

export default router;
