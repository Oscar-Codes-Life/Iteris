import {httpUrl} from './schema.js';

export const MAX_BYTES = 10 * 1024 * 1024;
export async function download(url: string, options: {endpoint: string; token: string; attachment?: boolean; signal?: AbortSignal; fetcher?: typeof fetch; maxBytes?: number; onBytes?: (bytes: number) => void}) {
	const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
	let current = httpUrl.parse(url);
	try {
		signal.throwIfAborted();
		for (let redirects = 0; redirects <= 5; redirects++) {
			const headers: Record<string, string> = {};
			if (new URL(current).origin === new URL(options.endpoint).origin) headers['Authorization'] = `Bearer ${options.token}`;
			const response = await (options.fetcher ?? fetch)(current, {headers, signal, redirect: 'manual'});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				if (!options.attachment) throw new Error('Endpoint redirects are not supported.');
				const location = response.headers.get('location');
				if (!location || redirects === 5) throw new Error('Attachment redirect failed.');
				current = httpUrl.parse(new URL(location, current).href);
				continue;
			}
			if (!response.ok) {await response.body?.cancel(); throw new Error(`HTTP ${response.status}`);}
			const limit = options.maxBytes ?? MAX_BYTES;
			if (Number(response.headers.get('content-length')) > limit) {await response.body?.cancel(); throw new Error('Download exceeds size limit.');}
			const reader = response.body?.getReader();
			const chunks: Uint8Array[] = []; let bytes = 0;
			if (reader) try {
				for (;;) {
					const result = await reader.read(); if (result.done) break;
					bytes += result.value.byteLength;
					options.onBytes?.(result.value.byteLength);
					if (bytes > limit) throw new Error('Download exceeds size limit.');
					chunks.push(result.value);
				}
			} finally {await reader.cancel().catch(() => {});}
			return {data: Buffer.concat(chunks), contentType: response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''};
		}
	} catch (error) {
		if (signal.aborted) throw new Error(options.signal?.aborted ? 'Import cancelled.' : 'Download timed out.');
		const message = error instanceof Error ? error.message : '';
		if (/^(HTTP \d+|Download exceeds size limit\.|Endpoint redirects are not supported\.|Attachment redirect failed\.)$/.test(message)) throw error;
		throw new Error('Download failed. Check the URL and network connection.');
	}
	throw new Error('Download failed.');
}
