import {AsyncLocalStorage} from 'node:async_hooks';

/** Host state stays in the launching project; Git and tools use the task checkout. */
const workspace = new AsyncLocalStorage<{root: string; key: string}>();
export const stateRoot = (cwd: string): string => workspace.getStore()?.root ?? cwd;
export const activeTaskKey = (): string | undefined => workspace.getStore()?.key;
export function inTaskWorkspace<T>(root: string, key: string, action: () => Promise<T>): Promise<T> {
	return workspace.run({root, key}, action);
}
