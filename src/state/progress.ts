import {readFile, appendFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const iterisDir = (cwd: string) => path.join(cwd, '.iteris');
const progressPath = (cwd: string) => path.join(iterisDir(cwd), 'progress.md');

export async function readProgress(cwd: string): Promise<string> {
	try {
		return await readFile(progressPath(cwd), 'utf8');
	} catch {
		return '';
	}
}

export async function appendProgress(cwd: string, entry: string): Promise<void> {
	await mkdir(iterisDir(cwd), {recursive: true});
	const timestamp = new Date().toISOString();
	await appendFile(progressPath(cwd), `\n[${timestamp}] ${entry}\n`);
}
