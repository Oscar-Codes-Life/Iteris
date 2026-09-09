import {createHash} from 'node:crypto';
import type {CustomConfig} from './schema.js';

export function atPath(value: unknown, parts: readonly (string | number)[]): unknown {
	for (const part of parts) {
		if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
		value = (value as Record<string | number, unknown>)[part];
	}
	return value;
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
	return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function usableId(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
	return undefined;
}
export function identifyItems(items: unknown[], config: CustomConfig) {
	const namespace = hash(canonical([config.endpoint, config.itemsPath ?? '']));
	const unique = new Map<string, {identity: string; fingerprint: string; item: unknown}>();
	let duplicates = 0;
	for (const item of items) {
		const id = config.idPath ? usableId(atPath(item, config.idPath.split('.'))) : usableId(atPath(item, ['id'])) ?? usableId(atPath(item, ['key']));
		const fingerprint = hash(canonical(item));
		const identity = hash(`${namespace}:${id === undefined ? 'content:' + fingerprint : 'id:' + id}`);
		const previous = unique.get(identity);
		if (previous && previous.fingerprint !== fingerprint) throw new Error('Custom response contains conflicting records with the same source ID.');
		if (previous) duplicates++;
		else unique.set(identity, {identity, fingerprint, item});
	}
	return {items: [...unique.values()], duplicates};
}
