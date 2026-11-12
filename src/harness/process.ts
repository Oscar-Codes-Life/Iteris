import {redact} from './redact.js';
import {spawn, type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {IterisConfig} from '../types.js';
import {protectHostAuthority} from '../lifecycle/authority.js';

export type Phase = 'planning' | 'implementation' | 'review' | 'repair' | 'pr-description' | 'summary' | 'import';
export type ProcessResult = {
	success: boolean; text: string; finalText?: string; done: boolean; timedOut: boolean; error?: string;
	/** The instance ended by saying the task needs something only a person can supply. */
	blocked?: boolean;
};
const signals = (message: string, signal: string) => message.split(/\r?\n/).some(part => part.trim() === signal);
/** What a writing instance is told about the two ways its turn may end. */
export const BLOCKED_NOTE = `If the ticket cannot be finished from this checkout because it needs something only a person or another ticket can supply (a physical device, production logs or dashboards, credentials or an account, a decision, or the merged or deployed result of another ticket), do not improvise, substitute a guess, or leave a placeholder for it. Say in a few plain sentences exactly what is missing and end with the one thing you need the person to supply, decide or do, then print exactly <task>blocked</task> on its own line. Iteris then stops the task and shows your message to the person as a question with a text field; their written answer is given to the instance that continues the task. Use this only for such outside needs: never for a failing check, a hard problem, or work you can still do here.`;
/** The instance's own explanation, without the signal line. */
export function blockedReason(result: Pick<ProcessResult, 'finalText' | 'text'>): string {
	const said = (result.finalText || result.text || '').split(/\r?\n/).filter(part => part.trim() !== '<task>blocked</task>').join('\n').trim();
	return said || 'The instance gave no explanation.';
}
export function invocation(config: IterisConfig, phase: Phase, images: string[] = []): {command: string; args: string[]; env: NodeJS.ProcessEnv} {
	const settings = config.harnesses[config.harness];
	const readOnly = phase === 'planning' || phase === 'pr-description' || phase === 'summary' || phase === 'import' || phase === 'review';
	const flags = readOnly ? [] : settings.flags.filter(flag => flag !== '--dangerously-skip-permissions');
	const env: NodeJS.ProcessEnv = {...process.env, ...config._execution?.env, PATH:config._execution?.path ?? process.env['PATH']};
	if (config.custom) delete env[config.custom.apiKeyEnv];
	const credentials=[...config.verification.checks.map(check=>check.command),...config.verification.stages.flatMap(stage=>[stage.execute,stage.verify].filter((command):command is NonNullable<typeof command>=>!!command)),...Object.values(config.integrations.status).flatMap(mapping=>[mapping.command,mapping.verify].filter((command):command is NonNullable<typeof command>=>!!command)),...(config.integrations.source?[config.integrations.source.command]:[])].flatMap(command=>[...Object.keys(command.env),...Object.values(command.env)]);
	for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'TRELLO_TOKEN', 'TRELLO_API_KEY', 'SSH_AUTH_SOCK', ...Object.keys(config.environment.env), ...Object.values(config.environment.env),...credentials]) delete env[key];
	if (config.harness === 'codex') {
		const args = ['exec', '--json', ...flags];
		args.push('--sandbox', readOnly ? 'read-only' : 'workspace-write', '-c', 'approval_policy="never"');
		if (settings.model) args.push('--model', settings.model);
		if (settings.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`);
		if (phase === 'review') args.push('--skip-git-repo-check');
		if (phase === 'import') {
			args.push('--skip-git-repo-check');
			for (const file of images) args.push('--image', file);
		}
		args.push('-');
		return {command: 'codex', args, env};
	}
	delete env['CLAUDE_CODE_EFFORT_LEVEL'];
	const args = ['--print', '--verbose', '--output-format', 'stream-json', ...flags];
	if (!readOnly) args.push('--setting-sources','','--tools','Read,Glob,Grep,Edit,Write,Bash','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','acceptEdits','--settings',JSON.stringify({disableAllHooks:true,sandbox:{enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,filesystem:{denyWrite:['.iteris/tasks/**','.iteris/active.json','.iteris.json']},network:{allowedDomains:[],strictAllowlist:true}},permissions:{deny:['Edit(.iteris.json)','Write(.iteris.json)','Edit(.iteris/tasks/**)','Write(.iteris/tasks/**)','Bash(git push *)','Bash(gh *)','Bash(curl *)','Bash(wget *)']}}));
	if (phase === 'review') args.push('--settings', JSON.stringify({disableAllHooks: true}));
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
	/** Overrides recovery.idleTimeout (milliseconds); 0 disables stall detection. */
	idleTimeoutMs?: number;
	onLine?: (line: string) => void; onProcess?: (process: ChildProcess) => void; signal?: AbortSignal;
}): Promise<ProcessResult> {
	const {command, args, env} = invocation(options.config, options.phase, options.images);
	const verifyAuthority=await protectHostAuthority(options.cwd);
	return new Promise(resolve => {
		if (options.signal?.aborted) {resolve({success: false, done: false, text: '', timedOut: false, error: 'Cancelled'}); return;}
		const proc = spawn(command, args, {cwd: options.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
		options.onProcess?.(proc);
		let text = ''; let finalText = ''; let done = false; let blocked = false; let error: string | undefined; let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, signal); else proc.kill(signal);} catch { /* already exited */ }
		};
		const stop = () => {kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);};
		const abort = () => {error = 'Cancelled'; stop();};
		options.signal?.addEventListener('abort', abort, {once: true});
		const timer = setTimeout(() => {timedOut = true; error = 'Process timed out'; stop();}, options.timeoutMs);
		// A stalled instance is killed early instead of consuming the whole task allowance.
		// The failure is journaled and a fresh instance continues from the preserved state.
		const idleMs = (options.idleTimeoutMs ?? (options.config.recovery?.idleTimeout ?? 0) * 1000);
		let idleTimer: NodeJS.Timeout | undefined;
		const touch = () => {
			if (!(idleMs > 0) || idleMs >= options.timeoutMs) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {timedOut = true; error = `Process stalled: no output for ${Math.round(idleMs / 1000)}s`; stop();}, idleMs);
		};
		touch();
		const stdout = createInterface({input: proc.stdout});
		const stderr = createInterface({input: proc.stderr});
		stdout.on('line', line => {
			touch();
			const event = decodeEvent(options.config.harness, redact(line));
			if (event.failed) error = event.failed;
			if (event.log) options.onLine?.(event.log);
			if (event.assistant) {
				text += event.assistant + '\n';
				finalText = event.assistant;
				if (signals(event.assistant, '<task>done</task>')) done = true;
				// Only the closing message counts: an instance that carried on afterwards was not stuck.
				blocked = signals(event.assistant, '<task>blocked</task>');
				options.onLine?.(event.assistant);
			}
		});
		stderr.on('line', line => {touch();const safe=redact(line);options.onLine?.(`[stderr] ${safe}`);if(/sandbox/i.test(safe)&&/unavailable|not supported|missing|cannot initialize|required.*fail|operation not permitted/i.test(safe))error=`Local permission capability unavailable: ${safe}`;});
		proc.stdin.on('error', err => {if ((err as NodeJS.ErrnoException).code !== 'EPIPE') error = err.message;});
		proc.on('error', err => {error = err.message;});
		// close occurs after stdout/stderr drain, including a final unterminated line.
		proc.on('close', async (code, signal) => {
			clearTimeout(timer); clearTimeout(killTimer); clearTimeout(idleTimer);
			options.signal?.removeEventListener('abort', abort);
			try{await verifyAuthority();}catch(failure){error=failure instanceof Error?failure.message:String(failure);}
			const success = code === 0 && !signal && !error && !timedOut;
			resolve({success, text: text.trim(), finalText, done, timedOut, ...(blocked && !done ? {blocked: true} : {}), error: error ?? (success ? undefined : `Process exited with ${signal ?? code}`)});
		});
		proc.stdin.end(options.prompt);
	});
}
