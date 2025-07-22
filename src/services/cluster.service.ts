import cluster from 'node:cluster';
import { Worker } from 'node:cluster';
import os from 'os';
import process from 'process';

/**
 * Сервис для кластеризации приложения
 * Позволяет запускать несколько экземпляров приложения на одном сервере
 * для более эффективного использования многоядерных процессоров
 */
export class ClusterService {
	private numCPUs: number;
	private workers: Map<number, Worker> = new Map();
	private isEnabled: boolean;

	/**
	 * Конструктор сервиса кластеризации
	 * @param enabled Включена ли кластеризация
	 */
	constructor(enabled: boolean = true) {
		this.numCPUs = os.cpus().length;
		this.isEnabled = enabled;
	}

	/**
	 * Запускает приложение в кластерном режиме
	 * @param appStartFunction Функция для запуска приложения
	 */
	public start(appStartFunction: () => void): void {
		if (!this.isEnabled) {
			console.log('Кластеризация отключена');
			appStartFunction();
			return;
		}

		if (this.isPrimary()) {
			console.log(`Master процесс ${process.pid} запущен`);
			console.log(`Запуск ${this.numCPUs} worker процессов...`);

			// Создаем worker процессы
			for (let i = 0; i < this.numCPUs; i++) {
				this.forkWorker();
			}

			// Обработка завершения worker процессов
			cluster.on('exit', (worker: Worker, code: number, signal: string) => {
				console.log(
					`Worker ${worker.process.pid} умер с кодом ${code} и сигналом ${signal}`,
				);

				// Удаляем worker из карты
				if (worker.id) {
					this.workers.delete(worker.id);
				}

				// Перезапускаем worker
				console.log('Перезапускаем worker...');
				this.forkWorker();
			});

			// Graceful shutdown
			process.on('SIGTERM', () => {
				console.log('Получен сигнал SIGTERM, завершаем работу...');
				this.shutdown();
			});

			process.on('SIGINT', () => {
				console.log('Получен сигнал SIGINT, завершаем работу...');
				this.shutdown();
			});
		} else {
			// Worker процесс
			console.log(`Worker ${process.pid} запущен`);
			appStartFunction();
		}
	}

	/**
	 * Создает новый worker процесс
	 */
	private forkWorker(): void {
		const worker = cluster.fork();

		if (worker.id) {
			this.workers.set(worker.id, worker);
		}

		// Обработка сообщений от worker
		worker.on('message', (message: any) => {
			// Ретранслируем сообщения между worker'ами
			this.broadcastMessage(message, worker.id);
		});

		// Обработка ошибок worker
		worker.on('error', (error) => {
			console.error(`Ошибка в worker ${worker.process.pid}:`, error);
		});

		// Обработка отключения worker
		worker.on('disconnect', () => {
			console.warn(`Worker ${worker.process.pid} отключен`);
		});
	}

	/**
	 * Проверяет, является ли процесс master
	 */
	public isPrimary(): boolean {
		return cluster.isPrimary;
	}

	/**
	 * Проверяет, является ли процесс worker
	 */
	public isWorker(): boolean {
		return cluster.isWorker;
	}

	/**
	 * Получает ID текущего worker'а
	 */
	public getWorkerId(): number {
		return cluster.isWorker ? cluster.worker!.id! : 0;
	}

	/**
	 * Отправляет сообщение master процессу
	 */
	public sendToMaster(message: any): void {
		if (cluster.isWorker && process.send) {
			process.send(message);
		}
	}

	/**
	 * Отправляет сообщение всем worker'ам (только для master)
	 */
	public sendToAllWorkers(message: any): void {
		if (cluster.isPrimary) {
			this.workers.forEach((worker) => {
				worker.send(message);
			});
		}
	}

	/**
	 * Ретранслирует сообщение между worker'ами
	 */
	private broadcastMessage(message: any, senderId?: number): void {
		if (cluster.isPrimary) {
			// Отправляем сообщение всем worker'ам, кроме отправителя
			this.workers.forEach((worker, workerId) => {
				if (workerId !== senderId) {
					worker.send(message);
				}
			});
		}
	}

	/**
	 * Graceful shutdown всех процессов
	 */
	private shutdown(): void {
		// Отправляем сигнал завершения всем worker'ам
		this.workers.forEach((worker) => {
			worker.kill('SIGTERM');
		});

		// Ждем завершения worker'ов
		setTimeout(() => {
			process.exit(0);
		}, 10000); // 10 секунд на graceful shutdown
	}

	/**
	 * Получает статистику кластера
	 */
	public getClusterStats(): {
		numCPUs: number;
		activeWorkers: number;
		isPrimary: boolean;
		workerId?: number;
	} {
		return {
			numCPUs: this.numCPUs,
			activeWorkers: this.workers.size,
			isPrimary: this.isPrimary(),
			workerId: this.isWorker() ? this.getWorkerId() : undefined,
		};
	}
}
