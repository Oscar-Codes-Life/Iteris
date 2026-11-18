/**
 * Runs items with at most `concurrency` at once. The first failure stops new items from starting and is thrown
 * once the running ones settle.
 *
 * `more` lets work join a pass that is already running: it is asked for items whenever a slot is free, before
 * the queued items, and about every `pollMs` while something still runs. It is never asked once nothing runs,
 * so a pass still ends when its last item does.
 */
export async function runPool<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>, signal?: AbortSignal, more?: () => Promise<T[]>, pollMs = 1000): Promise<void> {
	const queue = [...items], running = new Set<Promise<void>>();
	let failure: {reason: unknown} | undefined;
	const open = () => !signal?.aborted && !failure;
	for (;;) {
		if (more && open() && running.size < concurrency) {
			try {queue.unshift(...await more());} catch (reason) {failure ??= {reason};}
		}
		while (open() && running.size < concurrency && queue.length) {
			const task: Promise<void> = action(queue.shift()!).catch(reason => {failure ??= {reason};}).finally(() => {running.delete(task);});
			running.add(task);
		}
		if (!running.size) break;
		await waitForAny(running, more && running.size < concurrency ? pollMs : undefined);
	}
	if (failure) throw failure.reason;
}

/** Resolves when one task settles or, with `ms`, when that time has passed, whichever is first. */
async function waitForAny(tasks: Set<Promise<void>>, ms?: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {await Promise.race([...tasks, ...(ms === undefined ? [] : [new Promise<void>(resolve => {timer = setTimeout(resolve, ms);})])]);}
	finally {clearTimeout(timer);}
}
