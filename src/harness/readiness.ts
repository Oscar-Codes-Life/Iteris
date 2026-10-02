import {spawn} from 'node:child_process';
import {access, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import type {Harness} from '../types.js';

export type CommandResult = {code: number; output: string};
export async function command(executable: string, args: string[], interactive = false): Promise<CommandResult> {
	return new Promise(resolve => {
		const raw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
		if (interactive && raw) process.stdin.setRawMode(false);
		const child = spawn(executable, args, {stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe']});
		let output = ''; let failure: string | undefined;
		child.stdout?.on('data', (chunk: Buffer) => {output = (output + chunk.toString()).slice(-100_000);});
		child.stderr?.on('data', (chunk: Buffer) => {output = (output + chunk.toString()).slice(-100_000);});
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {failure = 'Command timed out'; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);}, interactive ? 600_000 : 30_000);
		child.on('error', error => {failure = error.message;});
		child.on('close', code => {if (interactive && raw) process.stdin.setRawMode(true); clearTimeout(timer); clearTimeout(killTimer); resolve({code: failure ? 1 : code ?? 1, output: failure ?? output});});
	});
}
export async function findExecutable(name: string): Promise<string | undefined> {
	for (const directory of (process.env['PATH'] ?? '').split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {await access(candidate, constants.X_OK); return await realpath(candidate);} catch { /* next PATH entry */ }
	}
	return undefined;
}
export class ReadinessError extends Error {
	constructor(message: string, readonly canContinue = false) {super(message);}
}
export async function codexCapabilities(): Promise<boolean> {
	const exec = await command('codex', ['exec', '--help']);
	const server = await command('codex', ['app-server', '--help']);
	return exec.code === 0 && server.code === 0 && ['--json', '--model', '--sandbox'].every(flag => exec.output.includes(flag));
}
let lastChecked: Harness | undefined;
export function resetReadiness(): void {lastChecked = undefined;}
export async function ensureHarness(harness: Harness, options: {skipUpdate?: boolean; onStatus?: (message: string) => void} = {}): Promise<void> {
	if (lastChecked === harness) return;
	const status = options.onStatus ?? console.log;
	const executable = await findExecutable(harness);
	if (!executable && harness === 'claude') throw new ReadinessError('Claude Code is missing. Install it and authenticate with claude auth login, then retry.');
	if (!executable) throw new ReadinessError('Codex is missing. Configure a project-local installer or install and authenticate it manually.');
	if (harness === 'codex' && !await codexCapabilities()) throw new ReadinessError('Installed Codex lacks required exec/app-server capabilities. Update it before continuing.');
	const authArgs = harness === 'codex' ? ['login', 'status'] : ['auth', 'status'];
	if ((await command(harness, authArgs)).code !== 0) {
		status(`Sign in to ${harness === 'codex' ? 'Codex' : 'Claude Code'} to continue.`);
		const login = await command(harness, harness === 'codex' ? ['login'] : ['auth', 'login'], true);
		if (login.code !== 0 || (await command(harness, authArgs)).code !== 0) throw new ReadinessError(`${harness} login did not complete. Retry or select another harness.`);
	}
	lastChecked = harness;
}
