import { prisma } from '../prisma';

/**
 * Проверяет, является ли пользователь администратором
 * @param telegramId ID пользователя в Telegram
 * @returns true, если пользователь админ
 */
export async function isUserAdmin(telegramId: string): Promise<boolean> {
	try {
		const user = await prisma.user.findUnique({
			where: { telegramId },
			select: { role: true },
		});

		return user?.role === 'admin';
	} catch (error) {
		console.error('Ошибка при проверке роли пользователя:', error);
		return false;
	}
}

/**
 * Извлекает ID пользователя из запроса
 * @param req Объект запроса с telegramUser
 * @returns ID пользователя или null
 */
export function getTelegramIdFromRequest(req: any): string | null {
	return req.body?.telegramUser?.id?.toString() || null;
}
