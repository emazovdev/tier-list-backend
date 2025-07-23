import { Response, NextFunction } from 'express';
import { TelegramRequest, PlayerWithSignedUrl } from '../types/api';
import { prisma } from '../prisma';
import { StorageService } from '../services/storage.service';
import { invalidateCache, invalidateClubsCache } from '../utils/cacheUtils';

// Создаем экземпляр сервиса для хранилища
const storageService = new StorageService();

// Константы для кэширования клубов (так как изменения игроков влияют на кэш клубов)
const CLUB_CACHE_KEYS = {
	ALL_CLUBS: 'cache:clubs:all',
	CLUB_BY_ID: 'cache:clubs:id:',
	CLUBS_WITH_PLAYERS: 'cache:clubs:with_players:',
};

/**
 * Создание нового игрока
 * КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Асинхронная загрузка файлов для быстрого ответа
 */
export const createPlayer = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const startTime = Date.now();

	try {
		const { name, clubId } = req.body;
		const file = req.file;

		console.log(`🚀 Создание игрока: ${name} для клуба ${clubId}`, {
			hasFile: !!file,
			fileSize: file?.size,
			timestamp: new Date().toISOString(),
		});

		if (!name || !clubId) {
			res.status(400).json({ error: 'Имя и клуб обязательны' });
			return;
		}

		// ОПТИМИЗАЦИЯ 1: Быстрые проверки с минимальными запросами
		const [club, existingPlayer] = await Promise.all([
			prisma.club.findUnique({
				where: { id: clubId },
				select: { id: true }, // Только ID для проверки существования
			}),
			prisma.players.findFirst({
				where: { name, clubId },
				select: { id: true },
			}),
		]);

		if (!club) {
			res.status(400).json({ error: 'Указанный клуб не существует' });
			return;
		}

		if (existingPlayer) {
			res.status(400).json({
				error: 'Игрок с таким именем уже существует в данном клубе',
			});
			return;
		}

		// КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Создаем игрока БЕЗ ожидания загрузки файла
		const player = await prisma.players.create({
			data: {
				name,
				avatar: '', // Изначально пустой, обновим позже
				clubId,
			},
			select: {
				id: true,
				name: true,
			},
		});

		console.log(`✅ Игрок создан в БД: ${player.id}`, {
			duration: Date.now() - startTime,
		});

		// КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Немедленно отвечаем пользователю
		res.status(201).json({
			ok: true,
			player: {
				id: player.id,
				name: player.name,
				avatarUrl: '', // Пока пустой, аватар загрузится асинхронно
			},
		});

		// АСИНХРОННАЯ ОБРАБОТКА: Загрузка файла и обновление аватара в фоне
		if (file) {
			// НЕ ждем завершения этих операций
			Promise.all([
				// Загружаем файл асинхронно
				storageService.uploadFile(file, 'players').then(async (avatarKey) => {
					console.log(`📁 Файл загружен: ${avatarKey}`);

					// Обновляем запись игрока с аватаром
					await prisma.players.update({
						where: { id: player.id },
						data: { avatar: avatarKey },
					});

					console.log(`🖼️ Аватар обновлен для игрока: ${player.id}`);
					return avatarKey;
				}),

				// Инвалидируем кэш асинхронно
				invalidateClubsCache(),
			]).catch((error: any) => {
				// Логируем ошибки фоновых операций, но не прерываем выполнение
				console.error('⚠️ Ошибка в асинхронных операциях создания игрока:', {
					playerId: player.id,
					error: error?.message || String(error),
				});
			});
		} else {
			// Если нет файла, только инвалидируем кэш
			invalidateClubsCache().catch((error: any) => {
				console.error(
					'⚠️ Ошибка инвалидации кэша:',
					error?.message || String(error),
				);
			});
		}

		// Логируем итоговую производительность
		const duration = Date.now() - startTime;
		console.log(`⏱️ Создание игрока завершено: ${duration}ms`);

		if (duration > 500) {
			console.warn(
				`🐌 Медленное создание игрока: ${duration}ms (ожидаемо <500ms)`,
			);
		}
	} catch (err: any) {
		const duration = Date.now() - startTime;
		console.error(`❌ Ошибка при создании игрока (${duration}ms):`, {
			error: err.message,
			stack: err.stack,
		});
		res.status(500).json({ error: 'Ошибка при создании игрока' });
	}
};

/**
 * Получение списка всех игроков
 */
export const getAllPlayers = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const players = await prisma.players.findMany({
			include: {
				club: {
					select: {
						id: true,
						name: true,
					},
				},
			},
		});

		// Собираем все ключи аватаров для батч-обработки
		const avatarKeys = players
			.map((player) => player.avatar)
			.filter(Boolean) as string[];

		// Получаем все URL за один раз
		const avatarUrls = await storageService.getBatchFastUrls(
			avatarKeys,
			'avatar',
		);

		// Формируем ответ с предварительно полученными URL
		const formattedPlayers = players.map((player) => ({
			id: player.id,
			name: player.name,
			avatarUrl: player.avatar ? avatarUrls[player.avatar] || '' : '',
		}));

		res.json({
			ok: true,
			players: formattedPlayers,
		});
	} catch (err: any) {
		console.error('Ошибка при получении игроков:', err);
		res.status(500).json({ error: 'Ошибка при получении игроков' });
	}
};

/**
 * Получение информации о конкретном игроке по ID
 */
export const getPlayerById = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;

		if (!id) {
			res.status(400).json({ error: 'ID игрока обязателен' });
			return;
		}

		const player = await prisma.players.findUnique({
			where: {
				id,
			},
			include: {
				club: {
					select: {
						id: true,
						name: true,
					},
				},
			},
		});

		if (!player) {
			res.status(404).json({ error: 'Игрок не найден' });
			return;
		}

		// Генерируем подписанный URL для аватара
		const avatarUrl = player.avatar
			? await storageService.getFastImageUrl(player.avatar, 'avatar')
			: '';

		res.json({
			ok: true,
			player: {
				id: player.id,
				name: player.name,
				avatarUrl,
				club: player.club
					? {
							id: player.club.id,
							name: player.club.name,
					  }
					: null,
			},
		});
	} catch (err: any) {
		console.error('Ошибка при получении игрока:', err);
		res.status(500).json({ error: 'Ошибка при получении игрока' });
	}
};

/**
 * Обновление информации об игроке
 * КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Асинхронная загрузка файлов для быстрого ответа
 */
export const updatePlayer = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const startTime = Date.now();

	try {
		const { id } = req.params;
		const { name, clubId } = req.body;
		const file = req.file;

		console.log(`🔄 Обновление игрока: ${id}`, {
			name,
			clubId,
			hasFile: !!file,
			fileSize: file?.size,
			timestamp: new Date().toISOString(),
		});

		if (!id) {
			res.status(400).json({ error: 'ID игрока обязателен' });
			return;
		}

		// ОПТИМИЗАЦИЯ: Параллельные проверки
		const [player, club] = await Promise.all([
			prisma.players.findUnique({
				where: { id },
				select: { id: true, name: true, avatar: true, clubId: true },
			}),
			clubId
				? prisma.club.findUnique({
						where: { id: clubId },
						select: { id: true },
				  })
				: Promise.resolve(true),
		]);

		if (!player) {
			res.status(404).json({ error: 'Игрок не найден' });
			return;
		}

		if (clubId && !club) {
			res.status(400).json({ error: 'Указанный клуб не существует' });
			return;
		}

		// КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Сначала обновляем основные данные БЕЗ аватара
		const updatedPlayer = await prisma.players.update({
			where: { id },
			data: {
				name: name || player.name,
				clubId: clubId || player.clubId,
				// avatar оставляем пока прежний
			},
			include: {
				club: {
					select: {
						id: true,
						name: true,
					},
				},
			},
		});

		console.log(`✅ Основные данные игрока обновлены: ${id}`, {
			duration: Date.now() - startTime,
		});

		// КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Немедленно отвечаем пользователю
		res.json({
			ok: true,
			player: {
				id: updatedPlayer.id,
				name: updatedPlayer.name,
				avatarUrl: player.avatar
					? await storageService.getFastImageUrl(player.avatar, 'avatar')
					: '',
				club: updatedPlayer.club
					? {
							id: updatedPlayer.club.id,
							name: updatedPlayer.club.name,
					  }
					: null,
			},
		});

		// АСИНХРОННАЯ ОБРАБОТКА: Загрузка нового аватара в фоне (если есть)
		if (file) {
			Promise.resolve().then(async () => {
				try {
					console.log(`📁 Начинаем загрузку нового аватара для игрока: ${id}`);

					// Загружаем новый аватар
					const newAvatarKey = await storageService.uploadFile(file, 'players');
					console.log(`📁 Новый аватар загружен: ${newAvatarKey}`);

					// Удаляем старый аватар (если был)
					if (player.avatar) {
						try {
							await storageService.deleteFile(player.avatar);
							console.log(`🗑️ Старый аватар удален: ${player.avatar}`);
						} catch (error: any) {
							console.error(
								'⚠️ Ошибка при удалении старого аватара:',
								error?.message || String(error),
							);
						}
					}

					// Обновляем запись в БД с новым аватаром
					await prisma.players.update({
						where: { id },
						data: { avatar: newAvatarKey },
					});

					console.log(`🖼️ Аватар обновлен в БД для игрока: ${id}`);
				} catch (error: any) {
					console.error('⚠️ Ошибка при асинхронном обновлении аватара:', {
						playerId: id,
						error: error?.message || String(error),
					});
				}
			});
		}

		// АСИНХРОННАЯ ОБРАБОТКА: Инвалидация кэша в фоне
		invalidateClubsCache().catch((error: any) => {
			console.error(
				'⚠️ Ошибка инвалидации кэша при обновлении игрока:',
				error?.message || String(error),
			);
		});

		// Логируем производительность
		const duration = Date.now() - startTime;
		console.log(`⏱️ Обновление игрока завершено: ${duration}ms`);

		if (duration > 500) {
			console.warn(
				`🐌 Медленное обновление игрока: ${duration}ms (ожидаемо <500ms)`,
			);
		}
	} catch (err: any) {
		const duration = Date.now() - startTime;
		console.error(`❌ Ошибка при обновлении игрока (${duration}ms):`, {
			error: err.message,
			stack: err.stack,
		});
		res.status(500).json({ error: 'Ошибка при обновлении игрока' });
	}
};

/**
 * Удаление игрока
 */
export const deletePlayer = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;

		if (!id) {
			res.status(400).json({ error: 'ID игрока обязателен' });
			return;
		}

		// Проверяем существование игрока и получаем информацию о его статистиках
		const player = await prisma.players.findUnique({
			where: {
				id,
			},
			include: {
				statistics: true, // Добавляем статистики для полной информации
			},
		});

		if (!player) {
			res.status(404).json({ error: 'Игрок не найден' });
			return;
		}

		console.log(`🗑️ Начинаем удаление игрока: ${player.name} (ID: ${id})`);
		console.log(`📊 Найдено ${player.statistics.length} записей статистики игрока`);

		// Выполняем все операции удаления в транзакции для обеспечения целостности данных
		await prisma.$transaction(async (tx) => {
			// 1. КРИТИЧЕСКИ ВАЖНО: Сначала удаляем все статистики игрока
			const deletedStatsCount = await tx.playerStatistics.deleteMany({
				where: {
					playerId: id,
				},
			});
			console.log(`📊 Удалено ${deletedStatsCount.count} записей статистики для игрока ${player.name}`);

			// 2. Удаляем самого игрока
			await tx.players.delete({
				where: { id },
			});
			console.log(`👤 Игрок ${player.name} удален из базы данных`);
		});

		// Удаляем аватар из хранилища ПОСЛЕ успешного удаления из БД
		if (player.avatar) {
			try {
				await storageService.deleteFile(player.avatar);
				console.log(`🖼️ Аватар игрока ${player.name} удален из хранилища`);
			} catch (error) {
				console.error(`⚠️ Ошибка при удалении аватара игрока ${player.name}:`, error);
				// Продолжаем выполнение даже при ошибке удаления файла
			}
		}

		// Инвалидируем кэш клубов полностью, так как удалился игрок
		await invalidateClubsCache();
		console.log(`🔄 Кэш клубов очищен`);

		console.log(`✅ Игрок ${player.name} и все его статистики успешно удалены`);

		res.json({
			ok: true,
			message: 'Игрок и все его статистики успешно удалены',
			deletedData: {
				player: player.name,
				statisticsCount: player.statistics.length,
			},
		});
	} catch (err: any) {
		console.error('❌ Ошибка при удалении игрока:', err);
		res.status(500).json({ 
			error: 'Ошибка при удалении игрока',
			details: err.message 
		});
	}
};
