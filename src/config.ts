import {execSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {IterisConfig} from './types.js';

export function resolveGithubToken(): string | undefined {
	const envToken = process.env['GITHUB_TOKEN'];
	if (envToken) return envToken;

	for (const shell of ['zsh', 'bash']) {
		try {
			const output = execSync(`${shell} -ilc 'echo $GITHUB_TOKEN'`, {
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			if (output) {
				process.env['GITHUB_TOKEN'] = output;
				return output;
			}
		} catch {
			// Shell not available, try next
		}
	}

	return undefined;
}

const configSchema = z.object({
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in "owner/repo" format'),
	todoLabel: z.string().default('Todo'),
	baseBranch: z.string().default('main'),
	timeout: z.number().positive().default(1200),
	claudeFlags: z.array(z.string()).default(['--dangerously-skip-permissions']),
	qualityChecks: z.array(z.string()).default([]),
	pr: z.object({
		draft: z.boolean().default(false),
		addLabelOnOpen: z.string().optional(),
	}).default({}),
});

export async function loadConfig(): Promise<IterisConfig> {
	const token = resolveGithubToken();
	if (!token) {
		throw new Error('GITHUB_TOKEN environment variable is not set. Iteris requires a GitHub token to fetch issues and create PRs.');
	}

	const configPath = path.join(process.cwd(), '.iteris.json');

	let raw: string;
	try {
		raw = await readFile(configPath, 'utf8');
	} catch {
		throw new Error(`Could not read .iteris.json at ${configPath}. Create a config file in your project root.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('.iteris.json contains invalid JSON.');
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`.iteris.json validation failed:\n${issues}`);
	}

	return result.data;
}
