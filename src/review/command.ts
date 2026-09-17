import {spawn} from 'node:child_process';
import {redact} from '../harness/redact.js';

/** Host-owned commands only. Model output is never executed by this helper. */
export async function runCommand(command: string, args: string[], options: {
	cwd: string; deadline: number; signal?: AbortSignal; shell?: boolean;
}): Promise<{exitCode: number | null; output: string; durationMs: number; error?: string; truncated: boolean}> {
	const started = Date.now();
	if (options.signal?.aborted || started >= options.deadline) return {exitCode: null, output: '', durationMs: 0, error: options.signal?.aborted ? 'Cancelled' : 'Review deadline exceeded', truncated: false};
	return new Promise(resolve => {
		const proc = spawn(command, args, {cwd: options.cwd, shell: options.shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
		let output = ''; let error: string | undefined; let truncated = false; let escalation: NodeJS.Timeout | undefined;
		const kill = (signal: NodeJS.Signals) => {try {if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, signal); else proc.kill(signal);} catch { /* already exited */ }};
		const stop = (reason: string) => {error = reason; kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), 2000);};
		const abort = () => stop('Cancelled');
		options.signal?.addEventListener('abort', abort, {once: true});
		if (options.signal?.aborted) abort();
		const timer = setTimeout(() => stop('Review deadline exceeded'), Math.max(1, options.deadline - Date.now()));
		const capture = (chunk: Buffer) => {
			const remaining = 1_000_000 - output.length;
			output += chunk.toString().slice(0, Math.max(0, remaining));
			if (chunk.length > remaining) truncated = true;
		};
		proc.stdout.on('data', capture); proc.stderr.on('data', capture);
		proc.on('error', failure => {error = failure.message;});
		proc.on('close', (code, signal) => {
			clearTimeout(timer); clearTimeout(escalation); options.signal?.removeEventListener('abort', abort);
			resolve({exitCode: code, output: redact(output), durationMs: Date.now() - started, truncated, error: error ?? (signal ? `Terminated by ${signal}` : undefined)});
		});
	});
}
