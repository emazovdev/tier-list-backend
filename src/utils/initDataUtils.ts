import { parse, validate } from '@telegram-apps/init-data-node';

export function parseInitData(initDataRaw: string) {
	try {
		const initData = parse(initDataRaw);

		return initData;
	} catch (e: any) {
		throw new Error(`Failed to parse init data: ${e.message}`);
	}
}

export const initDataUtils = {
	parse: parseInitData,
	validate: (initData: string, botToken: string) => {
		try {
			validate(initData, botToken);
			return { isValid: true };
		} catch (error: any) {
			return { isValid: false, error: error.message };
		}
	},
};
