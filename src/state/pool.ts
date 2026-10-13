/** Drain started jobs before releasing the queue lock, including on failure. */
export async function runPool<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
	let next = 0;
	let failed = false;
	const results = await Promise.allSettled(Array.from({length: Math.min(items.length, concurrency)}, async () => {
		while (!signal?.aborted && !failed) {
			const index = next++;
			if (index >= items.length) return;
			try {await action(items[index]!);} catch (error) {failed = true; throw error;}
		}
	}));
	const failure = results.find(result => result.status === 'rejected');
	if (failure?.status === 'rejected') throw failure.reason;
}
