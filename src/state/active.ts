import {mkdir, readFile, writeFile, unlink, rmdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
const filename = (cwd: string) => path.join(cwd, '.iteris', 'active.json');
export async function hasActiveRun(cwd = process.cwd()): Promise<boolean> {
	try {
		const {pid} = JSON.parse(await readFile(filename(cwd), 'utf8')) as {pid: number};
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {process.kill(pid, 0); return true;} catch (error) {return (error as NodeJS.ErrnoException).code === 'EPERM';}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		if (error instanceof SyntaxError) return true;
		throw error;
	}
}
export async function acquireRun(cwd: string): Promise<() => Promise<void>> {
	await mkdir(path.dirname(filename(cwd)), {recursive: true});
	const reclaim = `${filename(cwd)}.reclaim`;
	let claimed = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {await writeFile(filename(cwd), JSON.stringify({pid: process.pid}), {flag: 'wx', mode: 0o600}); claimed = true; break;} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await hasActiveRun(cwd)) throw new Error('An Iteris queue is already running in this repository. Use harness/model/effort commands to change its next ticket.');
			try {await mkdir(reclaim);} catch (failure) {
				if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
				await delay(50);
				continue;
			}
			try {
				// Recheck under the recovery guard so two new queues cannot both remove a stale lock.
				if (await hasActiveRun(cwd)) throw new Error('An Iteris queue is already running in this repository. Use harness/model/effort commands to change its next ticket.');
				try {await unlink(filename(cwd));} catch (failure) {if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;}
			} finally {await rmdir(reclaim);}
		}
	}
	if (!claimed) throw new Error(`Could not reclaim stale run lock at ${filename(cwd)}.`);
	return async () => {await unlink(filename(cwd)).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});};
}
