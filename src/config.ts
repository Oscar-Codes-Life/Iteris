import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {detectRepoFromRemote} from './github/repo.js';
import type {IterisConfig} from './types.js';

const configSchema = z.object({
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in "owner/repo" format').optional(),
	provider: z.enum(['github', 'trello']).optional(),
	todoStatus: z.string().default('Todo'),
	projectNumber: z.number().int().positive().optional(),
	baseBranch: z.string().default('main'),
	timeout: z.number().positive().default(1200),
	claudeFlags: z.array(z.string()).default(['--dangerously-skip-permissions']),
	qualityChecks: z.array(z.string()).default([]),
	pr: z.object({
		draft: z.boolean().default(false),
		addLabelOnOpen: z.string().optional(),
	}).default({}),
	trello: z.object({
		boardId: z.string().optional(),
		listId: z.string().optional(),
		moveOnComplete: z.string().optional(),
	}).optional(),
});

export async function saveConfigField(key: string, value: unknown): Promise<void> {
	const configPath = path.join(process.cwd(), '.iteris.json');

	let data: Record<string, unknown> = {};
	try {
		const raw = await readFile(configPath, 'utf8');
		data = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// File doesn't exist or invalid — start fresh
	}

	const parts = key.split('.');
	if (parts.length === 2) {
		const [outer, inner] = parts as [string, string];
		const nested = (data[outer] ?? {}) as Record<string, unknown>;
		nested[inner] = value;
		data[outer] = nested;
	} else {
		data[key] = value;
	}

	await writeFile(configPath, JSON.stringify(data, null, '\t') + '\n', 'utf8');
}

export async function loadConfig(): Promise<IterisConfig> {
	const configPath = path.join(process.cwd(), '.iteris.json');

	let parsed: Record<string, unknown> = {};
	let fileExisted = false;
	try {
		const raw = await readFile(configPath, 'utf8');
		fileExisted = true;
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (error) {
		if (fileExisted) {
			throw new Error('.iteris.json contains invalid JSON.');
		}
	}

	if (!parsed['repo']) {
		const detected = detectRepoFromRemote();
		if (!detected) {
			throw new Error('Could not auto-detect GitHub repo. Either create .iteris.json with a "repo" field (e.g. {"repo": "owner/repo"}) or ensure this is a git repository with a GitHub remote.');
		}
		parsed['repo'] = detected;
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`.iteris.json validation failed:\n${issues}`);
	}

	if (!fileExisted) {
		await writeFile(configPath, JSON.stringify(result.data, null, '\t') + '\n', 'utf8');
	}

	return result.data as IterisConfig;
}
