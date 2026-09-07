import {mkdir, readFile, writeFile, unlink} from 'node:fs/promises';
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
	if (await hasActiveRun(cwd)) throw new Error('An Iteris queue is already running in this repository. Use harness/model/effort commands to change its next ticket.');
	try {await writeFile(filename(cwd), JSON.stringify({pid: process.pid}), {flag: 'wx', mode: 0o600});} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		throw new Error(`Run lock exists at ${filename(cwd)}. If the previous Iteris process was forcibly killed, remove that stale file before restarting.`);
	}
	return async () => {await unlink(filename(cwd)).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});};
}
