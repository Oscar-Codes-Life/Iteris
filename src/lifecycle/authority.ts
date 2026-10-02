import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hash } from './state.js';
async function json(file: string): Promise<unknown> { try {
    return JSON.parse(await readFile(file, 'utf8'));
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined;
    throw error;
} }
async function stateFiles(cwd: string): Promise<string[]> {
    try {
        return (await readdir(path.join(cwd, '.iteris/tasks'))).filter(key => /^[a-f0-9]{64}$/.test(key)).map(key => path.join(cwd, '.iteris/tasks', key, 'run.json'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw error;
    }
}
const policy = (config: unknown) => {
    if (!config || typeof config !== 'object' || Array.isArray(config))
        return config;
    const copy = { ...config } as Record<string, unknown>;
    // These are the only live CLI selections accepted while a task executes.
    delete copy['harness'];
    if (copy['harnesses'] && typeof copy['harnesses'] === 'object') {
        copy['harnesses'] = Object.fromEntries(Object.entries(copy['harnesses']).map(([name, settings]) => {
            const policy = { ...settings as Record<string, unknown> };
            delete policy['model']; delete policy['effort'];
            return [name, policy];
        }));
    }
    return copy;
};
/** Restore host authority before any model-modified policy can reach an adapter. */
export async function protectHostAuthority(cwd: string): Promise<() => Promise<void>> {
    const configuration = path.join(cwd, '.iteris.json'), original = await json(configuration);
    const records = new Map<string, unknown>();
    for (const file of await stateFiles(cwd))
        records.set(file, await json(file));
    return async () => {
        let changed = false, current: unknown;
        try {
            current = await json(configuration);
        }
        catch {
            changed = true;
        }
        if (changed || hash(policy(original) ?? null) !== hash(policy(current) ?? null)) {
            changed = true;
            if (original === undefined)
                await unlink(configuration).catch(() => { });
            else {
                const preferences = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
                const restored = { ...original as Record<string, unknown> };
                if (preferences['harness'] !== undefined) restored['harness'] = preferences['harness'];
                if (restored['harnesses'] && typeof preferences['harnesses'] === 'object') {
                    restored['harnesses'] = Object.fromEntries(Object.entries(restored['harnesses'] as Record<string, Record<string, unknown>>).map(([name, settings]) => {
                        const current = (preferences['harnesses'] as Record<string, Record<string, unknown>>)[name] ?? {};
                        return [name, { ...settings, ...Object.fromEntries(['model', 'effort'].filter(key => current[key] !== undefined).map(key => [key, current[key]])) }];
                    }));
                }
                await atomicJson(configuration, restored);
            }
        }
        for (const file of new Set([...records.keys(), ...await stateFiles(cwd)])) {
            let value: unknown;
            try {
                value = await json(file);
            }
            catch {
                changed = true;
            }
            if (hash(value ?? null) !== hash(records.get(file) ?? null)) {
                changed = true;
                const saved = records.get(file);
                if (saved === undefined)
                    await unlink(file).catch(() => { });
                else
                    await atomicJson(file, saved);
            }
        }
        if (changed)
            throw new Error('Harness changed host-owned task state or verification/action policy. Original authority restored; independent verification is required.');
    };
}
