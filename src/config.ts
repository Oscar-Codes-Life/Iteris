import {execSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
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

function detectRepoFromRemote(): string | undefined {
	try {
		const url = execSync('git remote get-url origin', {
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();

		// SSH: git@github.com:owner/repo.git
		const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];

		// HTTPS: https://github.com/owner/repo.git
		const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
		if (httpsMatch) return httpsMatch[1];

		return undefined;
	} catch {
		return undefined;
	}
}

const configSchema = z.object({
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in "owner/repo" format').optional(),
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

	let repoAutoDetected = false;
	if (!parsed['repo']) {
		const detected = detectRepoFromRemote();
		if (!detected) {
			throw new Error('Could not auto-detect GitHub repo. Either create .iteris.json with a "repo" field (e.g. {"repo": "owner/repo"}) or ensure this is a git repository with a GitHub remote.');
		}
		parsed['repo'] = detected;
		repoAutoDetected = true;
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`.iteris.json validation failed:\n${issues}`);
	}

	if (repoAutoDetected) {
		await writeFile(configPath, JSON.stringify(parsed, null, '\t') + '\n', 'utf8');
	}

	return result.data as IterisConfig;
}
