import {readFile, writeFile, rename, unlink, copyFile, constants} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {detectRepoFromRemote, detectDefaultBranch} from './github/repo.js';
import type {IterisConfig} from './types.js';

const settings = z.object({
	model: z.string().min(1).optional(),
	effort: z.string().min(1).optional(),
	flags: z.array(z.string()).default([]),
}).passthrough();
export const configSchema = z.object({
	version: z.literal(2),
	harness: z.enum(['claude', 'codex']).default('claude'),
	harnesses: z.object({
		claude: settings.default({flags: ['--dangerously-skip-permissions']}),
		codex: settings.default({flags: []}),
	}).passthrough().default({}),
	setupComplete: z.boolean().default(false),
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in "owner/repo" format'),
	provider: z.enum(['github', 'trello']).optional(),
	githubSource: z.enum(['auto', 'issues', 'projects']).default('auto'),
	todoStatus: z.string().default('Todo'),
	projectNumber: z.number().int().positive().optional(),
	baseBranch: z.string().default('main'),
	timeout: z.number().positive().default(7200),
	planMode: z.boolean().default(true),
	qualityChecks: z.array(z.string()).default([]),
	pr: z.object({draft: z.boolean().default(false), addLabelOnOpen: z.string().optional()}).passthrough().default({}),
	trello: z.object({boardId: z.string().optional(), listId: z.string().optional(), moveOnComplete: z.string().optional()}).passthrough().optional(),
}).passthrough().superRefine((config, context) => {
	for (const harness of ['claude', 'codex'] as const) {
		for (const flag of config.harnesses[harness].flags) {
			// Iteris owns transport, selection and phase permissions. Do not allow
			// opaque config overrides to undo read-only planning or stream parsing.
			if (/^(--(model|effort|config|profile|output-format|input-format|permission-mode|tools|allowedTools|allowed-tools|disallowedTools|disallowed-tools|settings|json|sandbox|ask-for-approval|output-last-message|output-schema|print|resume|fork-session|session-id|system-prompt|append-system-prompt|dangerously-bypass-approvals-and-sandbox|full-auto|approve-for-me|ignore-rules|ignore-user-config|restricted)|-[mcpsao])(?:=|$)/.test(flag) || /^-[mcpsao].+/.test(flag)) {
				context.addIssue({code: 'custom', path: ['harnesses', harness, 'flags'], message: `${flag} is managed by Iteris. Use model/effort settings or remove the conflicting flag.`});
			}
		}
	}
});

function validate(data: unknown): IterisConfig {
	const result = configSchema.safeParse(data);
	if (!result.success) throw new Error(`.iteris.json validation failed:\n${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')}`);
	return result.data as IterisConfig;
}

export function migrateConfig(data: Record<string, unknown>): Record<string, unknown> {
	if (data['version'] === 2) return data;
	if (data['version'] !== undefined && data['version'] !== 1) throw new Error(`Unsupported .iteris.json version: ${String(data['version'])}`);
	const {claudeFlags, ...rest} = data;
	return {...rest, version: 2, harness: 'claude', setupComplete: false,
		harnesses: {claude: {flags: claudeFlags ?? ['--dangerously-skip-permissions']}, codex: {flags: []}}};
}

export async function atomicWriteConfig(data: IterisConfig, cwd = process.cwd()): Promise<void> {
	const validated = validate(data);
	const destination = path.join(cwd, '.iteris.json');
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(validated, null, '\t') + '\n', {flag: 'wx', mode: 0o600});
		await rename(temporary, destination);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

export async function loadConfig(cwd = process.cwd()): Promise<IterisConfig> {
	const configPath = path.join(cwd, '.iteris.json');
	let data: Record<string, unknown> = {};
	let existed = true;
	try {
		const raw = await readFile(configPath, 'utf8');
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
			data = parsed as Record<string, unknown>;
		} catch { throw new Error('.iteris.json contains invalid JSON or is not an object.'); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		existed = false;
	}
	const needsMigration = data['version'] !== 2;
	data = migrateConfig(data);
	if (!data['repo']) {
		const detected = detectRepoFromRemote(cwd);
		if (!detected) throw new Error('Could not auto-detect GitHub repo. Set repo to "owner/repo" in .iteris.json.');
		data['repo'] = detected;
	}
	if (!data['baseBranch']) data['baseBranch'] = detectDefaultBranch(cwd) ?? 'main';
	const config = validate(data);
	if (existed && needsMigration) {
		await copyFile(configPath, `${configPath}.v1.bak`, constants.COPYFILE_EXCL).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		});
	}
	if (!existed || needsMigration) await atomicWriteConfig(config, cwd);
	return config;
}

// Serialize in-process read/modify/write operations so wizard and live commands
// preserve each other's fields. Read from disk on every transaction.
let writes = Promise.resolve();
export async function updateConfig(mutator: (config: IterisConfig) => void, cwd = process.cwd()): Promise<IterisConfig> {
	const operation = writes.then(async () => {
		const config = await loadConfig(cwd);
		mutator(config);
		await atomicWriteConfig(config, cwd);
		return config;
	});
	writes = operation.then(() => {}, () => {});
	return operation;
}
export async function saveConfigField(key: string, value: unknown, cwd = process.cwd()): Promise<void> {
	await updateConfig(config => {
		const parts = key.split('.');
		let object = config as unknown as Record<string, unknown>;
		for (const part of parts.slice(0, -1)) {
			if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error('Invalid configuration key');
			object[part] ??= {};
			object = object[part] as Record<string, unknown>;
		}
		const last = parts.at(-1)!;
		if (['__proto__', 'prototype', 'constructor'].includes(last)) throw new Error('Invalid configuration key');
		object[last] = value;
	}, cwd);
}
