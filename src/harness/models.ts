import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {Harness, IterisConfig} from '../types.js';

export type ModelInfo = {id: string; label: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean};
// https://code.claude.com/docs/en/model-config (2026-09-07).
export const claudeModels: ModelInfo[] = [
	{id: 'opus', label: 'Opus 4.7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', isDefault: true},
	{id: 'sonnet', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high'},
	{id: 'haiku', label: 'Haiku 4.5', efforts: []},
	{id: 'claude-opus-4-7', label: 'Opus 4.7 (pinned)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh'},
	{id: 'claude-opus-4-6', label: 'Opus 4.6 (pinned)', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high'},
	{id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (pinned)', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high'},
	{id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (pinned)', efforts: []},
];

export async function listModels(harness: Harness): Promise<ModelInfo[]> {
	if (harness === 'claude') return structuredClone(claudeModels);
	return new Promise((resolve, reject) => {
		const proc = spawn('codex', ['app-server'], {stdio: ['pipe', 'pipe', 'pipe']});
		let settled = false; let id = 0; let stage = 'initialize'; const models: ModelInfo[] = [];
		const cursors = new Set<string>();
		const finish = (error?: Error) => {
			if (settled) return; settled = true; clearTimeout(timer);
			proc.stdin.end(); proc.kill('SIGTERM');
			const killTimer = setTimeout(() => proc.kill('SIGKILL'), 1000); killTimer.unref();
			proc.once('close', () => clearTimeout(killTimer));
			if (error) reject(error); else resolve(models);
		};
		const timer = setTimeout(() => finish(new Error('Codex model discovery timed out. Retry or select Claude.')), 20_000);
		const send = (method: string, params: unknown) => proc.stdin.write(JSON.stringify({id: ++id, method, params}) + '\n');
		createInterface({input: proc.stdout}).on('line', line => {
			try {
				const response = JSON.parse(line);
				if (response.id !== id) return;
				if (response.error) throw new Error(response.error.message ?? 'Codex model discovery failed');
				if (stage === 'initialize') {
					stage = 'models'; proc.stdin.write('{"method":"initialized"}\n');
					send('model/list', {limit: 100, includeHidden: false}); return;
				}
				if (!Array.isArray(response.result?.data)) throw new Error('Invalid Codex model catalog');
				for (const model of response.result.data) {
					if (model.hidden) continue;
					if (typeof model.model !== 'string' || !Array.isArray(model.supportedReasoningEfforts)) throw new Error('Invalid Codex model capabilities');
					const efforts = model.supportedReasoningEfforts.map((entry: {reasoningEffort: string}) => entry.reasoningEffort);
					if (efforts.some((effort: unknown) => typeof effort !== 'string')) throw new Error('Invalid effort options');
					models.push({id: model.model, label: model.displayName ?? model.model, efforts, defaultEffort: model.defaultReasoningEffort, isDefault: model.isDefault});
				}
				const cursor = response.result.nextCursor;
				if (cursor) {
					if (cursors.has(cursor)) throw new Error('Repeated Codex model catalog cursor');
					cursors.add(cursor); send('model/list', {limit: 100, includeHidden: false, cursor});
				} else finish(models.length ? undefined : new Error('No Codex models are available. Check login or select Claude.'));
			} catch (error) {finish(error instanceof Error ? error : new Error(String(error)));}
		});
		proc.stderr.resume();
		proc.stdin.on('error', error => finish(error));
		proc.on('error', error => finish(error));
		proc.on('close', () => {if (!settled) finish(new Error('Codex model discovery exited early'));});
		send('initialize', {clientInfo: {name: 'iteris', version: '2.0.0'}, capabilities: {}});
	});
}

export async function validateSelection(config: IterisConfig): Promise<void> {
	const settings = config.harnesses[config.harness];
	if (!settings.model) throw new Error('Choose a model with iteris model or iteris setup.');
	const models = await listModels(config.harness);
	const model = models.find(entry => entry.id === settings.model);
	if (!model) throw new Error(`Model ${settings.model} is unavailable for ${config.harness}. Run iteris model.`);
	if (settings.effort && !model.efforts.includes(settings.effort)) throw new Error(`Effort ${settings.effort} is unsupported by ${settings.model}. Run iteris effort.`);
	if (model.efforts.length && !settings.effort) throw new Error('Choose an effort level with iteris effort.');
}
