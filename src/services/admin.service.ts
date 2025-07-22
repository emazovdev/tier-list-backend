import { prisma } from '../prisma';
import { config } from '../config/env';
import {
	invalidateAdminCache,
	invalidateAllAdminCache,
	checkIsAdminUser,
} from '../middleware/checkAdminRole';

export class AdminService {
	/**
	 * Проверяет, является ли пользователь админом
	 * КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Используем унифицированную функцию из middleware
	 */
	static async isAdmin(telegramId: string): Promise<boolean> {
		return await checkIsAdminUser(telegramId);
	}

	/**
	 * Добавляет нового админа
	 */
	static async addAdmin(
		telegramId: string,
		username: string | null,
		addedBy: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			// Проверяем, что добавляющий является админом
			const isAdminUser = await this.isAdmin(addedBy);
			if (!isAdminUser) {
				return { success: false, message: 'Недостаточно прав' };
			}

			// Проверяем, не является ли пользователь уже админом
			const existingAdmin = await prisma.adminUser.findUnique({
				where: { telegramId },
			});

			if (existingAdmin) {
				return { success: false, message: 'Пользователь уже является админом' };
			}

			// Выполняем операции в транзакции для обеспечения целостности
			await prisma.$transaction(async (tx) => {
				// Добавляем нового админа
				await tx.adminUser.create({
					data: {
						telegramId,
						username,
						addedBy,
					},
				});

				// Обновляем роль пользователя в основной таблице
				await tx.user.updateMany({
					where: { telegramId },
					data: { role: 'admin' },
				});
			});

			// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Инвалидируем кэш админа сразу после добавления
			await invalidateAdminCache(telegramId);

			return { success: true, message: 'Админ успешно добавлен' };
		} catch (error) {
			console.error('Ошибка при добавлении админа:', error);
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Удаляет админа
	 */
	static async removeAdmin(
		telegramId: string,
		removedBy: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			// Проверяем, что удаляющий является админом
			const isAdminUser = await this.isAdmin(removedBy);
			if (!isAdminUser) {
				return { success: false, message: 'Недостаточно прав' };
			}

			// Нельзя удалить самого себя
			if (telegramId === removedBy) {
				return { success: false, message: 'Нельзя удалить самого себя' };
			}

			// Нельзя удалить главного админа (из переменной окружения)
			if (telegramId === config.telegram.adminId) {
				return { success: false, message: 'Нельзя удалить главного админа' };
			}

			// Выполняем операции в транзакции для обеспечения целостности
			await prisma.$transaction(async (tx) => {
				// Удаляем из таблицы админов
				await tx.adminUser.delete({
					where: { telegramId },
				});

				// Обновляем роль пользователя в основной таблице
				await tx.user.updateMany({
					where: { telegramId },
					data: { role: 'user' },
				});
			});

			// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Инвалидируем кэш админа сразу после удаления
			await invalidateAdminCache(telegramId);

			return { success: true, message: 'Админ успешно удален' };
		} catch (error) {
			console.error('Ошибка при удалении админа:', error);
			return { success: false, message: 'Админ не найден или ошибка сервера' };
		}
	}

	/**
	 * Ищет пользователей по username
	 */
	static async searchUsersByUsername(
		searchQuery: string,
		requestedBy: string,
	): Promise<{ success: boolean; users?: any[]; message: string }> {
		try {
			// Проверяем, что запрашивающий является админом
			const isAdminUser = await this.isAdmin(requestedBy);
			if (!isAdminUser) {
				return { success: false, message: 'Недостаточно прав' };
			}

			// Ищем пользователей по username (частичное совпадение)
			const users = await prisma.user.findMany({
				where: {
					username: {
						contains: searchQuery,
						mode: 'insensitive',
					},
				},
				select: {
					telegramId: true,
					username: true,
					role: true,
				},
				take: 10, // Ограничиваем количество результатов
			});

			return { success: true, users, message: 'Поиск выполнен успешно' };
		} catch (error) {
			console.error('Ошибка при поиске пользователей:', error);
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Добавляет нового админа по username
	 */
	static async addAdminByUsername(
		username: string,
		addedBy: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			// Проверяем, что добавляющий является админом
			const isAdminUser = await this.isAdmin(addedBy);
			if (!isAdminUser) {
				return { success: false, message: 'Недостаточно прав' };
			}

			// Ищем пользователя по username
			const user = await prisma.user.findFirst({
				where: {
					username: {
						equals: username,
						mode: 'insensitive',
					},
				},
			});

			if (!user) {
				return { success: false, message: 'Пользователь не найден' };
			}

			// Используем существующий метод добавления админа
			return await this.addAdmin(user.telegramId, user.username, addedBy);
		} catch (error) {
			console.error('Ошибка при добавлении админа по username:', error);
			return { success: false, message: 'Ошибка сервера' };
		}
	}

	/**
	 * Получает список всех админов
	 */
	static async getAdmins(): Promise<any[]> {
		try {
			const admins = await prisma.adminUser.findMany({
				select: {
					id: true,
					telegramId: true,
					username: true,
					addedBy: true,
					createdAt: true,
				},
				orderBy: { createdAt: 'asc' },
			});

			// Добавляем главного админа из переменной окружения, если его нет в списке
			const mainAdminExists = admins.some(
				(admin) => admin.telegramId === config.telegram.adminId,
			);

			if (!mainAdminExists) {
				admins.unshift({
					id: 'main-admin',
					telegramId: config.telegram.adminId,
					username: 'Главный админ',
					addedBy: null,
					createdAt: new Date('2024-01-01'),
				});
			}

			return admins;
		} catch (error) {
			console.error('Ошибка при получении списка админов:', error);
			return [];
		}
	}

	/**
	 * Проверяет изменение главного админа и сбрасывает список админов при необходимости
	 * Вызывается при запуске сервера
	 */
	static async checkAndResetAdminsOnMainAdminChange(): Promise<void> {
		try {
			const LAST_MAIN_ADMIN_KEY = 'last_main_admin_id';

			// Получаем сохраненный ID главного админа из базы данных
			const lastMainAdminId = await prisma.systemSettings.findUnique({
				where: { key: LAST_MAIN_ADMIN_KEY },
			});

			const currentMainAdminId = config.telegram.adminId;

			// Если главный админ изменился
			if (lastMainAdminId?.value !== currentMainAdminId) {
				console.log(
					`Обнаружено изменение главного админа: ${
						lastMainAdminId?.value || 'не установлен'
					} -> ${currentMainAdminId}`,
				);

				// Выполняем операции в транзакции для обеспечения целостности
				await prisma.$transaction(async (tx) => {
					// Удаляем всех админов кроме нового главного
					await tx.adminUser.deleteMany({
						where: {
							telegramId: {
								not: currentMainAdminId,
							},
						},
					});

					// Сбрасываем роли всех пользователей кроме главного админа
					await tx.user.updateMany({
						where: {
							telegramId: {
								not: currentMainAdminId,
							},
							role: 'admin',
						},
						data: {
							role: 'user',
						},
					});

					// Устанавливаем роль админа для нового главного админа
					await tx.user.updateMany({
						where: {
							telegramId: currentMainAdminId,
						},
						data: {
							role: 'admin',
						},
					});

					// Сохраняем новый ID главного админа
					await tx.systemSettings.upsert({
						where: { key: LAST_MAIN_ADMIN_KEY },
						update: { value: currentMainAdminId },
						create: {
							key: LAST_MAIN_ADMIN_KEY,
							value: currentMainAdminId,
						},
					});
				});

				// КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Полностью очищаем кэш админов при сбросе
				await invalidateAllAdminCache();

				console.log(
					`Список админов сброшен. Оставлен только главный админ: ${currentMainAdminId}`,
				);
			}
		} catch (error) {
			console.error('Ошибка при проверке изменения главного админа:', error);
		}
	}
}
