import { Response, NextFunction } from 'express';
import { TelegramRequest, AuthResponse } from '../types/api';
import { config } from '../config/env';
import { prisma } from '../prisma';
import { AdminService } from '../services/admin.service';
import { invalidateAdminCache } from '../middleware/checkAdminRole';

/**
 * Контроллер для авторизации пользователя через Telegram
 */
export const authUser = async (
	req: TelegramRequest,
	res: Response<AuthResponse | { error: string }>,
	next: NextFunction,
): Promise<void> => {
	try {
		const { telegramUser } = req.body;

		if (!telegramUser) {
			res.status(400).json({ error: 'Данные пользователя не найдены' });
			return;
		}

		const telegramId = telegramUser.id.toString();

		// Проверяем, является ли пользователь админом
		const isAdmin = await AdminService.isAdmin(telegramId);
		const role = isAdmin ? 'admin' : 'user';

		const existingUser = await prisma.user.findUnique({
			where: { telegramId },
		});

		let user;
		let roleChanged = false;

		if (!existingUser) {
			// Создаем нового пользователя
			user = await prisma.user.create({
				data: {
					telegramId,
					username: telegramUser.username || null,
					role,
				},
			});
		} else {
			// Обновляем только username и роль, если роль изменилась
			const needsUpdate =
				existingUser.username !== (telegramUser.username || null) ||
				existingUser.role !== role;

			// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Отслеживаем изменение роли
			roleChanged = existingUser.role !== role;

			if (needsUpdate) {
				user = await prisma.user.update({
					where: { telegramId },
					data: {
						username: telegramUser.username || existingUser.username,
						role,
					},
				});
			} else {
				user = existingUser;
			}
		}

		// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Инвалидируем кэш админа при изменении роли
		if (roleChanged) {
			await invalidateAdminCache(telegramId);
			console.log(
				`Роль пользователя ${telegramId} изменена с ${existingUser?.role} на ${role}, кэш инвалидирован`,
			);
		}

		res.json({
			ok: true,
			role,
			user: {
				id: user.id,
				telegramId: user.telegramId,
				username: user.username || undefined,
			},
		});
	} catch (err: any) {
		console.error('Ошибка авторизации:', err);
		res.status(500).json({ error: 'Ошибка авторизации' });
	}
};
