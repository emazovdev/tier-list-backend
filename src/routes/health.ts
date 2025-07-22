import { Router, Request, Response } from 'express';
import { redisService } from '../services/redis.service';
import { prisma } from '../prisma';
import { logger } from '../utils/logger';
import { puppeteerPoolService } from '../services/puppeteerPool.service';

const router = Router();

/**
 * Health check endpoint для мониторинга состояния приложения
 */
router.get('/', async (req: Request, res: Response) => {
	const healthCheck = {
		status: 'ok',
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
		memory: process.memoryUsage(),
		services: {
			database: 'unknown',
			redis: 'unknown',
		},
	};

	try {
		// Проверяем соединение с базой данных
		await prisma.$queryRaw`SELECT 1`;
		healthCheck.services.database = 'ok';
	} catch (error) {
		healthCheck.services.database = 'error';
		healthCheck.status = 'degraded';
		logger.error('Database health check failed', 'HEALTH', error);
	}

	try {
		// Проверяем соединение с Redis
		await redisService.get('health-check');
		healthCheck.services.redis = 'ok';
	} catch (error) {
		healthCheck.services.redis = 'error';
		healthCheck.status = 'degraded';
		logger.error('Redis health check failed', 'HEALTH', error);
	}

	// Возвращаем соответствующий статус код
	const statusCode = healthCheck.status === 'ok' ? 200 : 503;

	res.status(statusCode).json(healthCheck);
});

/**
 * Liveness probe - минимальная проверка что приложение работает
 */
router.get('/live', (req: Request, res: Response) => {
	res.status(200).json({
		status: 'alive',
		timestamp: new Date().toISOString(),
	});
});

/**
 * Readiness probe - проверка готовности к обслуживанию запросов
 */
router.get('/ready', async (req: Request, res: Response) => {
	try {
		// Быстрая проверка критически важных сервисов
		await Promise.all([
			prisma.$queryRaw`SELECT 1`,
			redisService.get('readiness-check'),
		]);

		res.status(200).json({
			status: 'ready',
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		logger.error('Readiness check failed', 'HEALTH', error);
		res.status(503).json({
			status: 'not_ready',
			timestamp: new Date().toISOString(),
			error: 'Service dependencies are not available',
		});
	}
});

router.get('/detailed', async (req: Request, res: Response) => {
	try {
		const checks = {
			database: false,
			redis: false,
			puppeteerPool: false,
		};

		// Проверяем соединение с базой данных
		try {
			await prisma.$queryRaw`SELECT 1`;
			checks.database = true;
		} catch (error) {
			logger.error('Health check - Database failed:', 'HEALTH', error);
			checks.database = false;
		}

		// Проверяем соединение с Redis
		try {
			await redisService.get('health-check');
			checks.redis = true;
		} catch (error) {
			logger.error('Health check - Redis failed:', 'HEALTH', error);
			checks.redis = false;
		}

		// Проверка пула браузеров Puppeteer
		try {
			const metrics = puppeteerPoolService.getMetrics();
			checks.puppeteerPool =
				metrics.totalBrowsers > 0 || metrics.queueSize < 50; // Здоров если есть браузеры или очередь не переполнена
		} catch (error) {
			logger.error('Health check - Puppeteer pool failed:', 'HEALTH', error);
			checks.puppeteerPool = false;
		}

		const allHealthy = Object.values(checks).every(Boolean);

		res.status(allHealthy ? 200 : 503).json({
			status: allHealthy ? 'healthy' : 'unhealthy',
			checks,
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			puppeteerMetrics: puppeteerPoolService.getMetrics(),
		});
	} catch (error) {
		logger.error('Health check failed:', 'HEALTH', error);
		res.status(503).json({
			status: 'unhealthy',
			error: 'Health check failed',
			timestamp: new Date().toISOString(),
		});
	}
});

export default router;
