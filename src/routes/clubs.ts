import { Router } from 'express';
import {
	createClub,
	deleteClub,
	getAllClubs,
	getClubById,
	updateClub,
} from '../controllers/clubs.controller';
import { initDataAuth } from '../middleware/validateInitData';
import { checkAdminRole } from '../middleware/checkAdminRole';
import {
	uploadClubLogo,
	handleUploadError,
} from '../middleware/uploadMiddleware';

const router = Router();

// Создание клуба - только для админа с загрузкой логотипа
router.post(
	'/',
	initDataAuth,
	checkAdminRole,
	uploadClubLogo,
	handleUploadError,
	createClub,
);

// Получение списка всех клубов - доступно авторизованным пользователям
router.get('/', initDataAuth, getAllClubs);

// Получение информации о конкретном клубе - доступно авторизованным пользователям
router.get('/:id', initDataAuth, getClubById);

// Обновление клуба - только для админа с загрузкой логотипа
router.put(
	'/:id',
	initDataAuth,
	checkAdminRole,
	uploadClubLogo,
	handleUploadError,
	updateClub,
);

// Удаление клуба - только для админа
router.delete('/:id', initDataAuth, checkAdminRole, deleteClub);

export default router;
