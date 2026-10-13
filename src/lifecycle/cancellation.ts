import {stateRoot} from '../state/workspace.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './state.js';
const filename = (cwd: string, key: string) => path.join(stateRoot(cwd), '.iteris', 'tasks', key, 'cancel.json');
export async function requestCancellation(cwd: string, key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('Invalid task key');
    await atomicJson(filename(cwd, key), { version: 1, requestedAt: new Date().toISOString() });
}
export async function cancellationRequested(cwd: string, key: string): Promise<boolean> {
    try {
        await readFile(filename(cwd, key));
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw error;
    }
}
/** A separate intent file lets cancellation reach an active writer without overwriting its run. */
export async function cancellationScope(cwd: string, key: string, parent?: AbortSignal) {
    const controller = new AbortController();
    let explicit = await cancellationRequested(cwd, key);
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    if (explicit || parent?.aborted)
        abort();
    const timer = setInterval(() => { void cancellationRequested(cwd, key).then(requested => { if (requested) {
        explicit = true;
        abort();
    } }, abort); }, 250);
    timer.unref();
    return { signal: controller.signal, cancelled: () => explicit, dispose: () => { clearInterval(timer); parent?.removeEventListener('abort', abort); } };
}
