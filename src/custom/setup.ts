import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {customConfigSchema} from './schema.js';
import {updateConfig} from '../config.js';
import type {IterisConfig} from '../types.js';

export async function setupCustom(config: IterisConfig, cwd = process.cwd()): Promise<IterisConfig> {
	const input = createInterface({input: stdin, output: stdout});
	const ask = async (label: string, initial = '') => {
		const value = (await input.question(`${label}${initial ? ` [${initial}]` : ''}: `)).trim();
		return value === '-' ? '' : value || initial;
	};
	try {
		const custom = customConfigSchema.parse({
			endpoint: await ask('REST endpoint URL', config.custom?.endpoint),
			apiKeyEnv: await ask('API key environment variable name (not its value)', config.custom?.apiKeyEnv ?? 'CUSTOM_API_KEY'),
			itemsPath: await ask('Items path (blank for a root array; - clears saved path)', config.custom?.itemsPath),
			idPath: await ask('ID path (blank to detect id/key; - clears saved path)', config.custom?.idPath) || undefined,
		});
		return await updateConfig(current => {current.custom = custom;}, cwd);
	} finally {input.close();}
}
