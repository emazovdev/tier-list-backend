import { Request } from 'express';

// Расширенный интерфейс Request с данными Telegram
export interface TelegramRequest extends Request {
	body: {
		telegramUser: {
			id: number;
			username?: string;
			first_name?: string;
			last_name?: string;
		};
		initData: any;
		[key: string]: any;
	};
}

// Тип ответа API аутентификации
export interface AuthResponse {
	ok: boolean;
	role: 'admin' | 'user';
	user: {
		id: string;
		telegramId: string;
		username?: string;
		first_name?: string;
	};
}

// Общий тип ответа API с ошибкой
export interface ErrorResponse {
	error: string;
}

// Базовые типы для работы с данными
export interface Club {
	id: string;
	name: string;
	logo: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface Player {
	id: string;
	name: string;
	avatar: string;
	clubId: string;
	createdAt: Date;
	updatedAt: Date;
}

// Расширенные типы для работы с подписанными URL
export interface ClubWithSignedUrl extends Club {
	logoUrl?: string;
	players?: PlayerWithSignedUrl[];
}

export interface PlayerWithSignedUrl extends Player {
	avatarUrl?: string;
	club?: {
		id: string;
		name: string;
	};
}
