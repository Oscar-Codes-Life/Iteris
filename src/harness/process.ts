import {redact} from './redact.js';
import {spawn, type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {IterisConfig} from '../types.js';

export type Phase = 'planning' | 'implementation' | 'review' | 'pr-description' | 'summary' | 'import';
export type ProcessResult = {success: boolean; text: string; done: boolean; timedOut: boolean; error?: string};
export function invocation(config: IterisConfig, phase: Phase, images: string[] = []): {command: string; args: string[]; env: NodeJS.ProcessEnv} {
	const settings = config.harnesses[config.harness];
	const readOnly = phase === 'planning' || phase === 'pr-description' || phase === 'summary' || phase === 'import';
	const flags = readOnly ? [] : settings.flags;
	const env = {...process.env};
	if (config.custom) delete env[config.custom.apiKeyEnv];
	if (config.harness === 'codex') {
		const args = ['exec', '--json', ...flags];
		args.push(...(readOnly ? ['--sandbox', 'read-only', '-c', 'approval_policy="never"'] : ['--dangerously-bypass-approvals-and-sandbox']));
		if (settings.model) args.push('--model', settings.model);
		if (settings.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`);
		if (phase === 'import') {
			args.push('--skip-git-repo-check');
			for (const file of images) args.push('--image', file);
		}
		args.push('-');
		return {command: 'codex', args, env};
	}
	delete env['CLAUDE_CODE_EFFORT_LEVEL'];
	const args = ['--print', '--verbose', '--output-format', 'stream-json', ...flags];
	if (readOnly) args.push('--permission-mode', 'plan', '--tools', phase === 'summary' || phase === 'pr-description' ? '' : phase === 'import' ? 'Read' : 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
	if (settings.model) args.push('--model', settings.model);
	if (settings.effort) {args.push('--effort', settings.effort); env['CLAUDE_CODE_EFFORT_LEVEL'] = settings.effort;}
	return {command: 'claude', args, env};
}

export type NormalizedEvent = {log?: string; assistant?: string; failed?: string};
export function decodeEvent(harness: 'claude' | 'codex', line: string): NormalizedEvent {
	let event: any;
	try { event = JSON.parse(line); } catch { return {failed: 'Invalid JSON from harness', log: line}; }
	if (harness === 'codex') {
		if (event.type === 'error' || event.type === 'turn.failed') return {failed: event.message ?? event.error?.message ?? 'Codex turn failed'};
		if (event.type === 'item.completed' && event.item?.type === 'agent_message') return {assistant: String(event.item.text ?? '')};
		if (event.item?.type === 'command_execution') return {log: `[command] ${event.item.command ?? ''}\n${event.item.aggregated_output ?? ''}`};
		return {log: `[${event.type ?? 'event'}]`};
	}
	if (event.type === 'result') return event.is_error ? {failed: event.result ?? event.errors?.join('\n') ?? 'Claude failed'} : {};
	if (event.type === 'assistant') {
		const blocks = event.message?.content ?? [];
		return {assistant: blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
			log: blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => `[tool] ${b.name}`).join('\n')};
	}
	return {log: `[${event.type ?? 'event'}]`};
}

export async function runHarness(options: {
	config: IterisConfig; phase: Phase; prompt: string; cwd: string; timeoutMs: number;
	images?: string[];
	onLine?: (line: string) => void; onProcess?: (process: ChildProcess) => void; signal?: AbortSignal;
}): Promise<ProcessResult> {
	const {command, args, env} = invocation(options.config, options.phase, options.images);
	return new Promise(resolve => {
		if (options.signal?.aborted) {resolve({success: false, done: false, text: '', timedOut: false, error: 'Cancelled'}); return;}
		const proc = spawn(command, args, {cwd: options.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
		options.onProcess?.(proc);
		let text = ''; let done = false; let error: string | undefined; let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, signal); else proc.kill(signal);} catch { /* already exited */ }
		};
		const stop = () => {kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);};
		const abort = () => {error = 'Cancelled'; stop();};
		options.signal?.addEventListener('abort', abort, {once: true});
		const timer = setTimeout(() => {timedOut = true; error = 'Process timed out'; stop();}, options.timeoutMs);
		const stdout = createInterface({input: proc.stdout});
		const stderr = createInterface({input: proc.stderr});
		stdout.on('line', line => {
			const event = decodeEvent(options.config.harness, redact(line));
			if (event.failed) error = event.failed;
			if (event.log) options.onLine?.(event.log);
			if (event.assistant) {
				text += event.assistant + '\n';
				if (event.assistant.split(/\r?\n/).some(part => part.trim() === '<task>done</task>')) done = true;
				options.onLine?.(event.assistant);
			}
		});
		stderr.on('line', line => options.onLine?.(`[stderr] ${redact(line)}`));
		proc.stdin.on('error', err => {if ((err as NodeJS.ErrnoException).code !== 'EPIPE') error = err.message;});
		proc.on('error', err => {error = err.message;});
		// close occurs after stdout/stderr drain, including a final unterminated line.
		proc.on('close', (code, signal) => {
			clearTimeout(timer); clearTimeout(killTimer);
			options.signal?.removeEventListener('abort', abort);
			const success = code === 0 && !signal && !error && !timedOut;
			resolve({success, text: text.trim(), done, timedOut, error: error ?? (success ? undefined : `Process exited with ${signal ?? code}`)});
		});
		proc.stdin.end(options.prompt);
	});
}
