import { Router } from 'express';
import { authUser } from '../controllers/auth.controller';
import { initDataAuth } from '../middleware/validateInitData';

const router = Router();

/**
 * @route   POST /api/auth
 * @desc    Авторизация через данные Telegram
 * @access  Public
 */
router.post('/', initDataAuth, authUser);

export default router;
