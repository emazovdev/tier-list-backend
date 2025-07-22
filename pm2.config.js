module.exports = {
	apps: [
		{
			name: 'myach-pro-server',
			script: './dist/index.js',
			cwd: '/projects/myach-pro/server',
			instances: 'max', // Используем все 8 CPU
			exec_mode: 'cluster', // Кластерный режим для масштабируемости
			env: {
				NODE_ENV: 'production',
				PORT: 3000,
				// Оптимизация Node.js для высоких нагрузок
				NODE_OPTIONS: '--max-old-space-size=4096 --max-semi-space-size=64',
				UV_THREADPOOL_SIZE: '32', // Увеличиваем пул потоков
			},
			// Автоматический перезапуск при изменениях
			watch: false,

			// Настройки логирования
			log_file: '/projects/myach-pro/logs/combined.log',
			out_file: '/projects/myach-pro/logs/out.log',
			error_file: '/projects/myach-pro/logs/error.log',
			log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

			// Настройки памяти
			max_memory_restart: '3G', // Увеличено для буферов и кэша
			node_args: [
				'--max-old-space-size=3072',
				'--optimize-for-size',
				'--gc-interval=100',
				'--trace-warnings',
			],

			// Настройки перезапуска
			restart_delay: 2000, // Быстрый перезапуск
			max_restarts: 15, // Больше попыток
			min_uptime: '30s', // Увеличен минимальный uptime

			// Автоматический перезапуск при превышении использования памяти
			kill_timeout: 10000, // Больше времени на graceful shutdown

			// Мониторинг
			monitoring: true,
			merge_logs: true,
			log_type: 'json',

			// Автоматическое масштабирование
			autorestart: true,

			// HEALTHCHECK для LOAD BALANCER
			health_check_url: 'http://localhost:3000/health',
			health_check_grace_period: 3000,

			// Переменные окружения для продакшена
			env_production: {
				NODE_ENV: 'production',
				PORT: 3000,
				// Дополнительные оптимизации для production
				NODE_OPTIONS:
					'--max-old-space-size=4096 --max-semi-space-size=64 --trace-gc',
			},
		},
	],
}
