import { NextFunction, Response } from 'express'
import { prisma } from '../prisma'
import { TelegramRequest } from '../types/api'
import { logger } from '../utils/logger'
import { getTelegramIdFromRequest, isUserAdmin } from '../utils/roleUtils'

interface GameResult {
	categorizedPlayerIds: { [categoryName: string]: string[] }
	clubId: string
}

interface PlayerRating {
	playerId: string
	playerName: string
	playerAvatar: string
	categoryName: string
	totalGames: number
	categoryHits: number
	hitPercentage: number
}

/**
 * Сохраняет результаты игры и обновляет статистику
 */
export const saveGameResults = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		// Проверяем роль пользователя - не сохраняем статистику для админов
		const telegramId = getTelegramIdFromRequest(req)
		if (telegramId) {
			const isAdmin = await isUserAdmin(telegramId)
			if (isAdmin) {
				logger.info(
					`Админ ${telegramId} играет в игру - статистика не сохраняется`
				)
				res.json({ ok: true, message: 'Результаты игры обработаны' })
				return
			}
		}

		const gameResults = req.body.gameResults as GameResult

		if (
			!gameResults ||
			!gameResults.categorizedPlayerIds ||
			!gameResults.clubId
		) {
			res.status(400).json({ error: 'Некорректные данные игры' })
			return
		}

		logger.info(`Сохранение результатов игры для клуба ${gameResults.clubId}`)

		// Проверяем существование клуба
		const club = await prisma.club.findUnique({
			where: { id: gameResults.clubId },
			select: { id: true },
		})

		if (!club) {
			res.status(400).json({ error: 'Клуб не найден' })
			return
		}

		// Получаем всех игроков из результатов
		const allPlayerIds = Object.values(gameResults.categorizedPlayerIds).flat()

		// Проверяем что все игроки существуют
		const existingPlayers = await prisma.players.findMany({
			where: {
				id: { in: allPlayerIds },
				clubId: gameResults.clubId,
			},
			select: { id: true },
		})

		if (existingPlayers.length !== allPlayerIds.length) {
			res.status(400).json({
				error: 'Некоторые игроки не найдены или не принадлежат этому клубу',
			})
			return
		}

		// Обновляем статистику в транзакции
		await prisma.$transaction(async tx => {
			// Для каждой категории обновляем статистику игроков
			for (const [categoryName, playerIds] of Object.entries(
				gameResults.categorizedPlayerIds
			)) {
				for (const playerId of playerIds) {
					// Получаем или создаем запись статистики для этого игрока и категории
					const existingStats = await tx.playerStatistics.findUnique({
						where: {
							playerId_categoryName: {
								playerId,
								categoryName,
							},
						},
					})

					if (existingStats) {
						// Обновляем существующую статистику
						const newCategoryHits = existingStats.categoryHits + 1
						const newTotalGames = existingStats.totalGames + 1
						const newHitPercentage = (newCategoryHits / newTotalGames) * 100

						await tx.playerStatistics.update({
							where: {
								playerId_categoryName: {
									playerId,
									categoryName,
								},
							},
							data: {
								categoryHits: newCategoryHits,
								totalGames: newTotalGames,
								hitPercentage: newHitPercentage,
								lastUpdated: new Date(),
							},
						})
					} else {
						// Создаем новую запись статистики
						await tx.playerStatistics.create({
							data: {
								playerId,
								clubId: gameResults.clubId,
								categoryName,
								totalGames: 1,
								categoryHits: 1,
								hitPercentage: 100.0,
							},
						})
					}
				}
			}

			// Для всех игроков этого клуба увеличиваем общее количество игр
			// в тех категориях, где они НЕ попали
			const allClubPlayers = await tx.players.findMany({
				where: { clubId: gameResults.clubId },
				select: { id: true },
			})

			for (const player of allClubPlayers) {
				// Проверяем в какие категории игрок НЕ попал
				// Поддерживаем как старые, так и новые категории
				const categoriesNotIn = [
					'goat',
					'Хорош',
					'норм',
					'Бездарь',
					'Бездна',
				].filter(category => {
					const playersInCategory =
						gameResults.categorizedPlayerIds[category] || []
					return !playersInCategory.includes(player.id)
				})

				// Для каждой категории где игрок НЕ попал, увеличиваем только totalGames
				for (const categoryName of categoriesNotIn) {
					const existingStats = await tx.playerStatistics.findUnique({
						where: {
							playerId_categoryName: {
								playerId: player.id,
								categoryName,
							},
						},
					})

					if (existingStats) {
						// Обновляем только totalGames, categoryHits остается прежним
						const newTotalGames = existingStats.totalGames + 1
						const newHitPercentage =
							(existingStats.categoryHits / newTotalGames) * 100

						await tx.playerStatistics.update({
							where: {
								playerId_categoryName: {
									playerId: player.id,
									categoryName,
								},
							},
							data: {
								totalGames: newTotalGames,
								hitPercentage: newHitPercentage,
								lastUpdated: new Date(),
							},
						})
					} else {
						// Создаем запись с 0 попаданий в эту категорию
						await tx.playerStatistics.create({
							data: {
								playerId: player.id,
								clubId: gameResults.clubId,
								categoryName,
								totalGames: 1,
								categoryHits: 0,
								hitPercentage: 0.0,
							},
						})
					}
				}
			}
		})

		logger.info(
			`Статистика игры успешно сохранена для клуба ${gameResults.clubId}`
		)
		res.json({ ok: true, message: 'Результаты игры сохранены' })
	} catch (error) {
		logger.error(
			'Ошибка при сохранении результатов игры:',
			(error as Error).message
		)
		res.status(500).json({ error: 'Ошибка сервера при сохранении результатов' })
	}
}

/**
 * Получает рейтинги игроков по команде
 */
export const getPlayerRatings = async (
	req: TelegramRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const { clubId } = req.params

		if (!clubId) {
			res.status(400).json({ error: 'ID клуба обязателен' })
			return
		}

		// Проверяем существование клуба
		const club = await prisma.club.findUnique({
			where: { id: clubId },
			select: { id: true, name: true },
		})

		if (!club) {
			res.status(404).json({ error: 'Клуб не найден' })
			return
		}

		// Получаем статистику всех игроков клуба
		const playerStats = await prisma.playerStatistics.findMany({
			where: { clubId },
			include: {
				player: {
					select: {
						id: true,
						name: true,
						avatar: true,
					},
				},
			},
			orderBy: [
				{ categoryName: 'asc' },
				{ hitPercentage: 'desc' },
				{ totalGames: 'desc' },
			],
		})

		// Группируем по категориям
		const ratingsByCategory: { [categoryName: string]: PlayerRating[] } = {}

		for (const stat of playerStats) {
			if (!ratingsByCategory[stat.categoryName]) {
				ratingsByCategory[stat.categoryName] = []
			}

			ratingsByCategory[stat.categoryName].push({
				playerId: stat.playerId,
				playerName: stat.player.name,
				playerAvatar: stat.player.avatar,
				categoryName: stat.categoryName,
				totalGames: stat.totalGames,
				categoryHits: stat.categoryHits,
				hitPercentage: Number(stat.hitPercentage),
			})
		}

		res.json({
			ok: true,
			club: {
				id: club.id,
				name: club.name,
			},
			ratingsByCategory,
		})
	} catch (error) {
		logger.error(
			'Ошибка при получении рейтингов игроков:',
			(error as Error).message
		)
		res.status(500).json({ error: 'Ошибка сервера при получении рейтингов' })
	}
}
