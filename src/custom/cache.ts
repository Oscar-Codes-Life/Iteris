import {readFile, readdir, realpath, stat, mkdir, writeFile, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import type {IterisConfig, Ticket} from '../types.js';
import {customConfigSchema, manifestSchema} from './schema.js';
import {customSourceKey} from './identity.js';
import {importCustom} from './import.js';

type ImportResult = Awaited<ReturnType<typeof importCustom>>;
type Services = NonNullable<Parameters<typeof importCustom>[2]> & {
	refresh?: boolean;
	useLegacy?: (directory: string, count: number) => Promise<boolean>;
};
const cacheSchema = z.object({version: z.literal(1), sourceKey: z.string(), directory: z.string().nullable(), duplicates: z.number().int().nonnegative()});

async function localFile(directory: string, filename: string): Promise<string> {
	const root = await realpath(directory);
	const file = await realpath(path.resolve(directory, filename));
	if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Invalid saved task file.');
	return path.resolve(directory, filename);
}
export async function readSavedCustomTasks(directory: string): Promise<ImportResult> {
	const manifest = manifestSchema.parse(JSON.parse(await readFile(await localFile(directory, 'manifest.json'), 'utf8')));
	const identities = new Set<string>(); const numbers = new Set<number>();
	const tickets: Ticket[] = [];
	for (const task of manifest.tasks) {
		if (identities.has(task.identity) || numbers.has(task.number)) throw new Error('Duplicate saved task identity or number.');
		identities.add(task.identity); numbers.add(task.number);
		const taskFile = await localFile(directory, task.file);
		for (const attachment of task.attachments) if (attachment.file) await localFile(directory, attachment.file);
		const body = await readFile(taskFile, 'utf8');
		if (!body.trim()) throw new Error('Empty saved task file.');
		tickets.push({number: task.number, title: task.title, body: body + `\nTask file: ${taskFile}\nResolve attachment paths relative to this task file.`, slug: `custom-${task.identity}`, labels: task.labels, htmlUrl: task.sourceUrl ?? '', custom: {identity: task.identity, fingerprint: task.fingerprint, taskFile}});
	}
	return {tickets, directory, duplicates: 0};
}

export async function loadCustomTasks(config: IterisConfig, cwd: string, services: Services = {}, signal?: AbortSignal): Promise<ImportResult & {cached: boolean}> {
	signal?.throwIfAborted();
	const sourceKey = customSourceKey(customConfigSchema.parse(config.custom));
	const cacheFile = path.join(cwd, '.iteris/custom/cache.json');
	const save = async (result: ImportResult) => {
		await mkdir(path.dirname(cacheFile), {recursive: true});
		const temporary = `${cacheFile}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify({version: 1, sourceKey, directory: result.directory ? path.relative(cwd, result.directory) : null, duplicates: result.duplicates}), {flag: 'wx', mode: 0o600});
			await rename(temporary, cacheFile);
		} finally {await unlink(temporary).catch(() => {});}
	};
	const reuse = async (directory: string): Promise<ImportResult> => {
		try {
			const root = await realpath(path.join(cwd, '.tasks'));
			const resolved = await realpath(directory);
			if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid cache directory');
			const manifest = manifestSchema.parse(JSON.parse(await readFile(await localFile(directory, 'manifest.json'), 'utf8')));
			if (manifest.sourceKey && manifest.sourceKey !== sourceKey) throw new Error('Cached source does not match');
			return await readSavedCustomTasks(directory);
		} catch {throw new Error('Downloaded custom tasks are incomplete or invalid. Run iteris refresh to download them again.');}
	};
	if (!services.refresh) {
		let cache: z.infer<typeof cacheSchema> | undefined;
		try {cache = cacheSchema.parse(JSON.parse(await readFile(cacheFile, 'utf8')));} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Custom task cache is invalid. Run iteris refresh to rebuild it.');
		}
		if (cache?.sourceKey === sourceKey) {
			const result = cache.directory ? await reuse(path.resolve(cwd, cache.directory)) : {tickets: [], duplicates: 0};
			return {...result, duplicates: cache.duplicates, cached: true};
		}
		// Imports made before caching was introduced have no source metadata.
		// Require a one-time choice before associating one with this endpoint.
		const root = path.join(cwd, '.tasks');
		const entries = await readdir(root, {withFileTypes: true}).catch(error => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		});
		const candidates = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const directory = path.join(root, entry.name);
			try {
				const file = await localFile(directory, 'manifest.json');
				const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
				if (manifest.sourceKey === sourceKey || (!cache && !manifest.sourceKey && services.useLegacy)) candidates.push({directory, manifest, modified: (await stat(file)).mtimeMs});
			} catch { /* Incomplete staging directories are never reused. */ }
		}
		candidates.sort((a, b) => b.modified - a.modified);
		const candidate = candidates.find(entry => entry.manifest.sourceKey === sourceKey) ?? candidates[0];
		if (candidate) {
			const result = await reuse(candidate.directory);
			if (candidate.manifest.sourceKey === sourceKey || await services.useLegacy?.(candidate.directory, result.tickets.length)) {
				await save(result);
				return {...result, cached: true};
			}
		}
	}
	const result = await importCustom(config, cwd, services, signal);
	await save(result);
	return {...result, cached: false};
}
