import { Request, Response, NextFunction } from 'express';
import { redisService } from '../services/redis.service';
import { logger } from '../utils/logger';

interface UserLimitState {
	dailyCount: number;
	lastRequestTime: number;
	consecutiveRequests: number;
	lastResetDate: string;
}

/**
 * Специальный rate limiter для пользователей с интервалами
 * 5 раз в день + интервал 10 минут после 2-х запросов подряд
 */
export class UserImageRateLimit {
	private readonly DAILY_LIMIT = 5; // Максимум 5 раз в день
	private readonly CONSECUTIVE_LIMIT = 2; // После 2 запросов подряд - интервал
	private readonly INTERVAL_MINUTES = 10; // Интервал 10 минут
	private readonly RESET_HOUR = 0; // Сброс в полночь

	/**
	 * Генерирует ключ для Redis
	 */
	private getUserKey(userId: string): string {
		return `user_image_limit:${userId}`;
	}

	/**
	 * Получает текущую дату в формате YYYY-MM-DD
	 */
	private getCurrentDate(): string {
		return new Date().toISOString().split('T')[0];
	}

	/**
	 * Получает состояние лимитов пользователя
	 */
	private async getUserState(userId: string): Promise<UserLimitState> {
		try {
			const key = this.getUserKey(userId);
			const data = await redisService.get(key);

			if (!data) {
				return {
					dailyCount: 0,
					lastRequestTime: 0,
					consecutiveRequests: 0,
					lastResetDate: this.getCurrentDate(),
				};
			}

			const state: UserLimitState = JSON.parse(data);

			// Сбрасываем дневной счетчик если новый день
			if (state.lastResetDate !== this.getCurrentDate()) {
				state.dailyCount = 0;
				state.consecutiveRequests = 0;
				state.lastResetDate = this.getCurrentDate();
			}

			return state;
		} catch (error) {
			logger.error(
				'Ошибка получения состояния пользователя:',
				'USER_RATE_LIMIT',
				error,
			);
			// Возвращаем дефолтное состояние в случае ошибки
			return {
				dailyCount: 0,
				lastRequestTime: 0,
				consecutiveRequests: 0,
				lastResetDate: this.getCurrentDate(),
			};
		}
	}

	/**
	 * Сохраняет состояние лимитов пользователя
	 */
	private async saveUserState(
		userId: string,
		state: UserLimitState,
	): Promise<void> {
		try {
			const key = this.getUserKey(userId);
			await redisService.set(key, JSON.stringify(state), 25 * 60 * 60); // 25 часов TTL
		} catch (error) {
			logger.error(
				'Ошибка сохранения состояния пользователя:',
				'USER_RATE_LIMIT',
				error,
			);
		}
	}

	/**
	 * Проверяет можно ли пользователю сделать запрос
	 */
	private checkLimits(state: UserLimitState): {
		allowed: boolean;
		reason?: string;
		retryAfter?: number;
		remainingDaily?: number;
	} {
		const now = Date.now();

		// Проверяем дневной лимит
		if (state.dailyCount >= this.DAILY_LIMIT) {
			const tomorrow = new Date();
			tomorrow.setDate(tomorrow.getDate() + 1);
			tomorrow.setHours(this.RESET_HOUR, 0, 0, 0);

			return {
				allowed: false,
				reason: `Превышен дневной лимит (${this.DAILY_LIMIT} изображений в день)`,
				retryAfter: Math.ceil((tomorrow.getTime() - now) / 1000),
				remainingDaily: 0,
			};
		}

		// Проверяем интервал после consecutive запросов
		if (state.consecutiveRequests >= this.CONSECUTIVE_LIMIT) {
			const timeSinceLastRequest = now - state.lastRequestTime;
			const intervalMs = this.INTERVAL_MINUTES * 60 * 1000;

			if (timeSinceLastRequest < intervalMs) {
				const retryAfter = Math.ceil(
					(intervalMs - timeSinceLastRequest) / 1000,
				);

				return {
					allowed: false,
					reason: `Интервал между запросами: ${this.INTERVAL_MINUTES} минут после ${this.CONSECUTIVE_LIMIT} запросов`,
					retryAfter,
					remainingDaily: this.DAILY_LIMIT - state.dailyCount,
				};
			}
		}

		return {
			allowed: true,
			remainingDaily: this.DAILY_LIMIT - state.dailyCount - 1, // -1 для текущего запроса
		};
	}

	/**
	 * Обновляет состояние после успешного запроса
	 */
	private updateStateAfterRequest(state: UserLimitState): UserLimitState {
		const now = Date.now();
		const timeSinceLastRequest = now - state.lastRequestTime;
		const intervalMs = this.INTERVAL_MINUTES * 60 * 1000;

		// Если прошло больше интервала, сбрасываем consecutive счетчик
		if (timeSinceLastRequest > intervalMs) {
			state.consecutiveRequests = 1;
		} else {
			state.consecutiveRequests += 1;
		}

		state.dailyCount += 1;
		state.lastRequestTime = now;

		return state;
	}

	/**
	 * Middleware функция
	 */
	public middleware() {
		return async (
			req: Request,
			res: Response,
			next: NextFunction,
		): Promise<any> => {
			try {
				// Получаем ID пользователя из Telegram данных
				const userId = (req as any).telegramUser?.id;

				if (!userId) {
					// Если нет userId, используем обычный IP-based лимит
					return next();
				}

				// Получаем текущее состояние пользователя
				const state = await this.getUserState(userId.toString());

				// Проверяем лимиты
				const check = this.checkLimits(state);

				// Добавляем заголовки для клиента
				res.setHeader('X-RateLimit-Daily-Limit', this.DAILY_LIMIT);
				res.setHeader('X-RateLimit-Daily-Remaining', check.remainingDaily || 0);
				res.setHeader('X-RateLimit-Consecutive-Limit', this.CONSECUTIVE_LIMIT);
				res.setHeader('X-RateLimit-Interval-Minutes', this.INTERVAL_MINUTES);

				if (!check.allowed) {
					if (check.retryAfter) {
						res.setHeader('Retry-After', check.retryAfter);
					}

					// Логируем превышение лимита
					logger.warn(
						`Превышен лимит для пользователя ${userId}: ${check.reason}`,
						'USER_RATE_LIMIT',
					);

					return res.status(429).json({
						error: check.reason,
						retryAfter: check.retryAfter,
						dailyLimit: this.DAILY_LIMIT,
						remainingDaily: check.remainingDaily,
						consecutiveLimit: this.CONSECUTIVE_LIMIT,
						intervalMinutes: this.INTERVAL_MINUTES,
					});
				}

				// Обновляем состояние для успешного запроса
				const updatedState = this.updateStateAfterRequest(state);
				await this.saveUserState(userId.toString(), updatedState);

				// Обновляем заголовки после обновления состояния
				res.setHeader(
					'X-RateLimit-Daily-Remaining',
					updatedState.dailyCount < this.DAILY_LIMIT
						? this.DAILY_LIMIT - updatedState.dailyCount
						: 0,
				);
				res.setHeader(
					'X-RateLimit-Consecutive-Count',
					updatedState.consecutiveRequests,
				);

				logger.info(
					`Пользователь ${userId}: ${updatedState.dailyCount}/${this.DAILY_LIMIT} в день, consecutive: ${updatedState.consecutiveRequests}`,
					'USER_RATE_LIMIT',
				);

				next();
			} catch (error) {
				logger.error('Ошибка в user rate limiter:', 'USER_RATE_LIMIT', error);
				// В случае ошибки разрешаем запрос
				next();
			}
		};
	}

	/**
	 * Получает статистику пользователя
	 */
	public async getUserStats(userId: string): Promise<{
		dailyCount: number;
		remainingDaily: number;
		consecutiveRequests: number;
		nextResetTime: string;
		isInInterval: boolean;
		intervalRemainingSeconds?: number;
	}> {
		const state = await this.getUserState(userId);
		const now = Date.now();

		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(this.RESET_HOUR, 0, 0, 0);

		const timeSinceLastRequest = now - state.lastRequestTime;
		const intervalMs = this.INTERVAL_MINUTES * 60 * 1000;
		const isInInterval =
			state.consecutiveRequests >= this.CONSECUTIVE_LIMIT &&
			timeSinceLastRequest < intervalMs;

		return {
			dailyCount: state.dailyCount,
			remainingDaily: Math.max(0, this.DAILY_LIMIT - state.dailyCount),
			consecutiveRequests: state.consecutiveRequests,
			nextResetTime: tomorrow.toISOString(),
			isInInterval,
			intervalRemainingSeconds: isInInterval
				? Math.ceil((intervalMs - timeSinceLastRequest) / 1000)
				: undefined,
		};
	}

	/**
	 * Сброс лимитов для пользователя (только для админов)
	 */
	public async resetUserLimits(userId: string): Promise<void> {
		const key = this.getUserKey(userId);
		await redisService.delete(key);
		logger.info(`Лимиты пользователя ${userId} сброшены`, 'USER_RATE_LIMIT');
	}
}

export const userImageRateLimit = new UserImageRateLimit();
