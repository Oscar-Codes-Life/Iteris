import path from 'node:path';
import {acquireRun} from '../state/active.js';
import {runCodeReview} from '../agent/reviewer.js';
import {git, digest} from './context.js';
import {reviewSettings} from './schema.js';
import type {IterisConfig, Ticket} from '../types.js';

export async function reviewBranch(config: IterisConfig, cwd: string, mode?: string): Promise<boolean> {
	if (mode && !['standard', 'deep', 'audit'].includes(mode)) throw new Error('Use iteris review [standard|deep|audit].');
	const release = await acquireRun(cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on('SIGINT', abort); process.on('SIGTERM', abort);
	try {
		const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
		const ticket: Ticket = {number: 0, title: `Review ${branch}`, slug: 'branch-review', labels: [], htmlUrl: '',
			body: 'Review this existing branch for correctness, security and maintainability. There is no linked ticket; assess compatibility and behavior evidenced by the code and tests. Label inferred intent explicitly and do not invent product requirements.'};
		const folder = path.join(cwd, '.iteris', 'reviews', digest(branch).slice(0, 16));
		const selected = {...config, review: {...reviewSettings(config.review), mode: mode === 'deep' || mode === 'audit' ? 'deep' as const : mode === 'standard' ? 'standard' as const : reviewSettings(config.review).mode}};
		const result = await runCodeReview({ticket, config: selected, cwd, folder, branch, signal: controller.signal, audit: true, onProcess() {}, onLogLine: line => console.log(line)});
		console.log(`\n${result.text}\n\nReport: ${path.join(folder, 'review/review.md')}`);
		return result.success;
	} finally {
		process.off('SIGINT', abort); process.off('SIGTERM', abort); await release();
	}
}
