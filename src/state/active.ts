import {mkdir, readFile, writeFile, unlink, rmdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
const filename = (cwd: string) => path.join(cwd, '.iteris', 'active.json');
const queueFile = (cwd: string) => path.join(cwd, '.iteris', 'queue.json');
const RUNNING = 'An Iteris queue is already running in this repository. Use harness/model/effort commands to change its next ticket.';
/** Whether the process that wrote this lock file is still alive. */
async function held(file: string): Promise<boolean> {
	try {
		const {pid} = JSON.parse(await readFile(file, 'utf8')) as {pid: number};
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {process.kill(pid, 0); return true;} catch (error) {return (error as NodeJS.ErrnoException).code === 'EPERM';}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		if (error instanceof SyntaxError) return true;
		throw error;
	}
}
/** A queue is working here: either it is inside a pass, or it is waiting for its next one. */
export async function hasActiveRun(cwd = process.cwd()): Promise<boolean> {
	return await held(filename(cwd)) || await held(queueFile(cwd));
}
async function claim(file: string): Promise<() => Promise<void>> {
	await mkdir(path.dirname(file), {recursive: true});
	const reclaim = `${file}.reclaim`;
	let claimed = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {await writeFile(file, JSON.stringify({pid: process.pid}), {flag: 'wx', mode: 0o600}); claimed = true; break;} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await held(file)) throw new Error(RUNNING);
			try {await mkdir(reclaim);} catch (failure) {
				if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
				await delay(50);
				continue;
			}
			try {
				// Recheck under the recovery guard so two new queues cannot both remove a stale lock.
				if (await held(file)) throw new Error(RUNNING);
				try {await unlink(file);} catch (failure) {if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;}
			} finally {await rmdir(reclaim);}
		}
	}
	if (!claimed) throw new Error(`Could not reclaim stale run lock at ${file}.`);
	return async () => {await unlink(file).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});};
}
/** The lock held while tasks are being worked on. Short commands take it too, between a queue's passes. */
export function acquireRun(cwd: string): Promise<() => Promise<void>> {
	return claim(filename(cwd));
}
const queues = new Map<string, number>();
/**
 * Marks this process as the queue of this repository for as long as it lives, the waits between passes
 * included. The run lock is released during those waits so short commands can run; without this mark a
 * second queue could start in one of them and work on the same tasks. Nested claims in one process share it.
 */
export async function claimQueue(cwd: string): Promise<() => Promise<void>> {
	const file = queueFile(cwd), nested = queues.get(file) ?? 0;
	const release = nested ? undefined : await claim(file);
	queues.set(file, (queues.get(file) ?? 0) + 1);
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		const left = (queues.get(file) ?? 1) - 1;
		if (left) {queues.set(file, left); return;}
		queues.delete(file);
		await (release ?? (async () => {await unlink(file).catch(() => {});}))();
	};
}
