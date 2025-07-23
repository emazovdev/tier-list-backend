import { Response, NextFunction } from 'express';
import {
	TelegramRequest,
	ClubWithSignedUrl,
	PlayerWithSignedUrl,
} from '../types/api';
import { prisma } from '../prisma';
import { StorageService } from '../services/storage.service';
import {
	withCache,
	invalidateCache,
	invalidateClubsCache,
	createCacheOptions,
} from '../utils/cacheUtils';
import { isUserAdmin, getTelegramIdFromRequest } from '../utils/roleUtils';

// Создаем экземпляр сервиса для хранилища
const storageService = new StorageService();

// Константы для кэширования
const CACHE_KEYS = {
	ALL_CLUBS: 'cache:clubs:all',
	CLUB_BY_ID: 'cache:clubs:id:',
	CLUBS_WITH_PLAYERS: 'cache:clubs:with_players:',
};

/**
 * Создание нового клуба (только для админа)
 */
export const createClub = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { name } = req.body;
		const file = req.file;

		if (!name) {
			res.status(400).json({ error: 'Название клуба обязательно' });
			return;
		}

		const isClubExists = await prisma.club.findFirst({
			where: {
				name,
			},
		});

		if (isClubExists) {
			res.status(400).json({ error: 'Клуб с таким названием уже существует' });
			return;
		}

		// Если файл не загружен, создаем клуб без логотипа
		if (!file) {
			const club = await prisma.club.create({
				data: {
					name,
					logo: '',
				},
			});

			// Инвалидируем все связанные кэши
			await invalidateClubsCache();

			res.status(201).json({
				ok: true,
				club: {
					id: club.id,
					name: club.name,
					logoUrl: '',
				},
			});
			return;
		}

		// Загружаем файл в R2 и получаем ключ файла
		const logoKey = await storageService.uploadFile(file, 'clubs');

		// Создаем клуб с ключом логотипа
		const club = await prisma.club.create({
			data: {
				name,
				logo: logoKey,
			},
		});

		// Генерируем оптимизированный URL для доступа к логотипу
		const logoUrl = club.logo
			? await storageService.getFastImageUrl(club.logo, 'logo')
			: '';

		// Инвалидируем все связанные кэши
		await invalidateClubsCache();

		res.status(201).json({
			ok: true,
			club: {
				id: club.id,
				name: club.name,
				logoUrl,
			},
		});
	} catch (err: any) {
		console.error('Ошибка при создании клуба:', err);
		res.status(500).json({ error: 'Ошибка при создании клуба' });
	}
};

/**
 * Получение списка всех клубов (доступно всем пользователям)
 */
export const getAllClubs = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		// Проверяем, является ли пользователь админом
		const telegramId = getTelegramIdFromRequest(req);
		const isAdmin = telegramId ? await isUserAdmin(telegramId) : false;

		// Создаем опции кэширования с учетом роли пользователя
		const cacheOptions = createCacheOptions(isAdmin, { ttl: 3600 });

		// Используем кэширование для получения списка клубов
		const formattedClubs = await withCache(
			async () => {
				const clubs = await prisma.club.findMany({
					orderBy: { name: 'asc' },
				});

				// Собираем все ключи логотипов для батч-обработки
				const logoKeys = clubs
					.map((club) => club.logo)
					.filter(Boolean) as string[];

				// Получаем все URL за один раз
				const logoUrls = await storageService.getBatchFastUrls(
					logoKeys,
					'logo',
				);

				// Формируем ответ с предварительно полученными URL
				const result = clubs.map((club) => ({
					id: club.id,
					name: club.name,
					logoUrl: club.logo ? logoUrls[club.logo] || '' : '',
				}));

				return result;
			},
			CACHE_KEYS.ALL_CLUBS,
			cacheOptions,
		);

		res.json({
			ok: true,
			clubs: formattedClubs,
		});
	} catch (err: any) {
		console.error('❌ Ошибка при получении клубов:', {
			error: err.message,
			stack: err.stack,
			timestamp: new Date().toISOString(),
		});
		res.status(500).json({ error: 'Ошибка при получении клубов' });
	}
};

/**
 * Получение информации о конкретном клубе по ID
 */
export const getClubById = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;

		if (!id) {
			res.status(400).json({ error: 'ID клуба обязателен' });
			return;
		}

		// Проверяем, является ли пользователь админом
		const telegramId = getTelegramIdFromRequest(req);
		const isAdmin = telegramId ? await isUserAdmin(telegramId) : false;

		// Создаем опции кэширования с учетом роли пользователя
		const cacheOptions = createCacheOptions(isAdmin, { ttl: 3600 });

		// Используем кэширование для получения информации о клубе
		const clubData = await withCache(
			async () => {
				const club = await prisma.club.findUnique({
					where: {
						id,
					},
					include: {
						players: {
							orderBy: { name: 'asc' },
						},
					},
				});

				if (!club) {
					return null;
				}

				// Собираем все ключи изображений для батч-обработки
				const logoKey = club.logo ? [club.logo] : [];
				const avatarKeys = club.players
					.map((player) => player.avatar)
					.filter(Boolean) as string[];

				// Получаем все URL за один раз
				const [logoUrls, avatarUrls] = await Promise.all([
					storageService.getBatchFastUrls(logoKey, 'logo'),
					storageService.getBatchFastUrls(avatarKeys, 'avatar'),
				]);

				// URL для логотипа
				const logoUrl = club.logo ? logoUrls[club.logo] || '' : '';

				// Игроки с аватарами
				const players = club.players.map((player) => ({
					id: player.id,
					name: player.name,
					avatarUrl: player.avatar ? avatarUrls[player.avatar] || '' : '',
				}));

				return {
					id: club.id,
					name: club.name,
					logoUrl,
					players,
				};
			},
			`${CACHE_KEYS.CLUB_BY_ID}${id}`,
			cacheOptions,
		);

		if (!clubData) {
			res.status(404).json({ error: 'Клуб не найден' });
			return;
		}

		res.json({
			ok: true,
			club: clubData,
		});
	} catch (err: any) {
		console.error('Ошибка при получении клуба:', err);
		res.status(500).json({ error: 'Ошибка при получении клуба' });
	}
};

/**
 * Обновление информации о клубе (только для админа)
 */
export const updateClub = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;
		const { name } = req.body;
		const file = req.file;

		if (!id) {
			res.status(400).json({ error: 'ID клуба обязателен' });
			return;
		}

		// Проверяем существование клуба
		const club = await prisma.club.findUnique({
			where: {
				id,
			},
		});

		if (!club) {
			res.status(404).json({ error: 'Клуб не найден' });
			return;
		}

		let logoKey = club.logo;

		// Если загружен новый файл, обновляем логотип
		if (file) {
			// Если у клуба уже был логотип, удаляем старый файл
			if (club.logo) {
				try {
					await storageService.deleteFile(club.logo);
				} catch (error) {
					console.error('Ошибка при удалении старого логотипа:', error);
					// Продолжаем выполнение даже при ошибке удаления
				}
			}

			// Загружаем новый файл
			logoKey = await storageService.uploadFile(file, 'clubs');
		}

		// Обновляем данные клуба
		const updatedClub = await prisma.club.update({
			where: {
				id,
			},
			data: {
				name: name || club.name,
				logo: logoKey,
			},
		});

		// Инвалидируем все связанные кэши
		await invalidateClubsCache();

		// URL для логотипа
		const logoUrl = updatedClub.logo
			? await storageService.getFastImageUrl(updatedClub.logo, 'logo')
			: '';

		res.json({
			ok: true,
			club: {
				id: updatedClub.id,
				name: updatedClub.name,
				logoUrl,
			},
		});
	} catch (err: any) {
		console.error('Ошибка при обновлении клуба:', err);
		res.status(500).json({ error: 'Ошибка при обновлении клуба' });
	}
};

/**
 * Удаление клуба (только для админа)
 */
export const deleteClub = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;

		if (!id) {
			res.status(400).json({ error: 'ID клуба обязателен' });
			return;
		}

		// Проверяем существование клуба
		const club = await prisma.club.findUnique({
			where: {
				id,
			},
			include: {
				players: true,
				playerStatistics: true, // Добавляем статистики для полной информации
			},
		});

		if (!club) {
			res.status(404).json({ error: 'Клуб не найден' });
			return;
		}

		console.log(`🗑️ Начинаем удаление клуба: ${club.name} (ID: ${id})`);
		console.log(`📊 Найдено ${club.players.length} игроков и ${club.playerStatistics.length} записей статистики`);

		// Выполняем все операции удаления в транзакции для обеспечения целостности данных
		await prisma.$transaction(async (tx) => {
			// 1. КРИТИЧЕСКИ ВАЖНО: Сначала удаляем все статистики игроков
			const deletedStatsCount = await tx.playerStatistics.deleteMany({
				where: {
					clubId: id,
				},
			});
			console.log(`📊 Удалено ${deletedStatsCount.count} записей статистики для клуба ${id}`);

			// 2. Удаляем всех игроков клуба (после удаления их статистик)
			if (club.players.length > 0) {
				const deletedPlayersCount = await tx.players.deleteMany({
					where: {
						clubId: id,
					},
				});
				console.log(`👥 Удалено ${deletedPlayersCount.count} игроков для клуба ${id}`);
			}

			// 3. Обнуляем clubId в игровых сессиях, связанных с удаляемым клубом
			// Это предотвращает отображение "Неизвестный клуб" в аналитике
			const updatedSessionsCount = await tx.gameSession.updateMany({
				where: {
					clubId: id,
				},
				data: {
					clubId: null,
				},
			});
			console.log(`🎮 Обновлено ${updatedSessionsCount.count} игровых сессий для клуба ${id}`);

			// 4. Удаляем сам клуб
			await tx.club.delete({
				where: {
					id,
				},
			});
			console.log(`🏟️ Клуб ${club.name} удален из базы данных`);
		});

		// Удаляем файлы из хранилища ПОСЛЕ успешного удаления из БД
		// Если удаление из БД не удалось, файлы останутся (что лучше чем потерять данные)
		
		// Удаляем аватары игроков
		if (club.players.length > 0) {
			console.log(`🖼️ Удаляем ${club.players.length} аватаров игроков...`);
			let deletedAvatarsCount = 0;
			for (const player of club.players) {
				if (player.avatar) {
					try {
						await storageService.deleteFile(player.avatar);
						deletedAvatarsCount++;
					} catch (error) {
						console.error(
							`⚠️ Ошибка при удалении аватара игрока ${player.name} (${player.id}):`,
							error,
						);
						// Продолжаем выполнение даже при ошибке удаления файла
					}
				}
			}
			console.log(`✅ Удалено ${deletedAvatarsCount} аватаров игроков`);
		}

		// Удаляем логотип клуба
		if (club.logo) {
			try {
				await storageService.deleteFile(club.logo);
				console.log(`🏷️ Логотип клуба ${club.name} удален из хранилища`);
			} catch (error) {
				console.error(`⚠️ Ошибка при удалении логотипа клуба ${club.name}:`, error);
				// Продолжаем выполнение даже при ошибке удаления файла
			}
		}

		// Инвалидируем все связанные кэши
		await invalidateClubsCache();
		console.log(`🔄 Кэш клубов очищен`);

		console.log(`✅ Клуб ${club.name} и все связанные данные успешно удалены`);

		res.json({
			ok: true,
			message: 'Клуб, игроки, статистики и все связанные данные успешно удалены',
			deletedData: {
				club: club.name,
				playersCount: club.players.length,
				statisticsCount: club.playerStatistics.length,
			},
		});
	} catch (err: any) {
		console.error('❌ Ошибка при удалении клуба:', err);
		res.status(500).json({ 
			error: 'Ошибка при удалении клуба',
			details: err.message 
		});
	}
};
