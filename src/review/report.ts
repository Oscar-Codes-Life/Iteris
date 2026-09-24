import {mkdir, writeFile, rename, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {redact} from '../harness/redact.js';
import {z} from 'zod';
import {blocks, candidateSchema, verificationSchema, type ReviewReport, type ReviewResult} from './schema.js';
import type {ReviewContext} from './context.js';

export async function saveJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), {recursive: true});
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, redact(JSON.stringify(value, null, 2)) + '\n', {mode: 0o600});
	await rename(temporary, file);
}

/** Checkpoints are host-owned evidence, always validated against an exact input key. */
export async function loadCheckpoint<T>(directory: string, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
	try {
		const stored = JSON.parse(await readFile(path.join(directory, 'checkpoints', `${key}.json`), 'utf8')) as {key?: string; value?: unknown};
		if (stored.key === key) return schema.parse(stored.value);
	} catch { /* Missing, interrupted, or incompatible evidence must be regenerated. */ }
	return;
}
export async function saveCheckpoint(directory: string, key: string, value: unknown): Promise<void> {
	await saveJson(path.join(directory, 'checkpoints', `${key}.json`), {key, value});
}

export const checksSchema = z.array(z.object({command: z.string(), head: z.string(), exitCode: z.number().nullable(), output: z.string(), durationMs: z.number(), error: z.string().optional(), truncated: z.boolean()}));
const inline = (value: string) => value.replace(/[\r\n]+/g, ' ').replaceAll('`', "'").replace(/[<>]/g, '');
export function renderReport(report: ReviewReport): string {
	return [
		'## Iteris review', '', `**${report.outcome.toUpperCase()}** — ${inline(report.reason)}`,
		`Reviewed commit: \`${report.stamp?.head ?? 'unavailable'}\`. Mode: ${report.mode}. Rounds: ${report.rounds}; repairs: ${report.repairs}.`,
		`Reviewer: ${inline(report.selection.harness)} / ${inline(report.selection.model ?? 'default')} / ${inline(report.selection.effort ?? 'default')}. Usage/cost: unavailable.`, '',
		'### Acceptance', '', ...report.requirements.map(item => `- **${item.status}** ${inline(item.requirement)} — ${inline(item.evidence)}`),
		...(report.requirements.length ? [] : ['- Not verified.']), '', '### Checks', '',
		...report.checks.map(check => `- \`${inline(check.command)}\`: ${check.error ? inline(check.error) : `exit ${check.exitCode}`} (${check.durationMs} ms), commit \`${check.head}\`.`),
		...(report.checks.length ? [] : ['- No executable checks run; see outcome and repository configuration.']), '', '### Findings', '',
		...report.findings.filter(f => f.status !== 'rejected').map(f => `- **${f.status}${blocks(f) ? ' / blocker' : ''} / ${f.priority}** ${inline(f.title)} — \`${inline(f.file)}:${f.line}\` (${f.side}, \`${f.head}\`). ${inline(f.verification ?? f.evidence)}${f.fixedAt ? ` Fixed at \`${f.fixedAt}\`.` : ''}`),
		...(report.findings.some(f => f.status !== 'rejected') ? [] : ['- No confirmed findings.']), '',
		'### Unverified areas', '', ...report.gaps.map(gap => `- ${inline(gap)}`), ...(report.gaps.length ? [] : ['- None reported by the required reviewers.']),
		'', 'Automated readiness evidence; human merge approval is still required.',
	].join('\n');
}
export async function finishReport(directory: string, attempt: string, report: ReviewReport): Promise<ReviewResult> {
	report.finishedAt = new Date().toISOString();
	const text = redact(renderReport(report));
	await saveJson(path.join(attempt, 'result.json'), report);
	await saveJson(path.join(directory, 'result.json'), report);
	await writeFile(path.join(directory, 'review.md'), text + '\n');
	const success = report.outcome === 'passed';
	return {report, text, success, done: success, timedOut: /deadline|timed out/i.test(report.reason), error: success ? undefined : report.reason};
}
export async function loadPassedReview(directory: string, context: ReviewContext): Promise<ReviewResult | undefined> {
	try {
		const report = storedReportSchema.parse(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')));
		if (report.version !== 1 || report.outcome !== 'passed' || report.stamp?.key !== context.stamp.key || report.stamp.head !== context.stamp.head) return;
		// Recovery may append checks; configured checks must still be present in order.
		if (report.checks.length < context.checks.length || context.checks.some((command, index) => report.checks[index]?.command !== command)) return;
		if (report.gaps.length || report.findings.some(blocks) || !report.requirements.length || report.requirements.some(r => r.status !== 'covered') || report.checks.some(c => c.head !== context.stamp.head || c.exitCode !== 0 || c.error)) return;
		return {report, text: renderReport(report), success: true, done: true, timedOut: false};
	} catch {return;}
}

export async function previousEvidence(directory: string, context: ReviewContext): Promise<ReviewReport | undefined> {
	try {
		const report = storedReportSchema.parse(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')));
		if (report.stamp.scope === context.stamp.scope) return report;
	} catch { /* no compatible previous evidence */ }
	return;
}

const storedReportSchema = z.object({
	version: z.literal(1), outcome: z.enum(['passed', 'blocked', 'incomplete']), reason: z.string(),
	deferredToCI: z.boolean().optional(),
	stamp: z.object({head: z.string(), base: z.string(), mergeBase: z.string(), branch: z.string(), scope: z.string(), key: z.string()}),
	startedAt: z.string().datetime(), finishedAt: z.string().datetime(), rounds: z.number().int().positive(), repairs: z.number().int().nonnegative(),
	findings: z.array(candidateSchema.extend({id: z.string(), head: z.string(), status: z.enum(['candidate', 'confirmed', 'rejected', 'fixed']), verification: z.string().optional(), fixedAt: z.string().optional(), duplicateOf: z.string().optional()})),
	// Interrupted investigations can have a valid stamp before requirements exist.
	requirements: z.array(verificationSchema.shape.requirements.element),
	checks: checksSchema,
	gaps: z.array(z.string()), mode: z.enum(['standard', 'deep']), selection: z.object({harness: z.string(), model: z.string().optional(), effort: z.string().optional()}), usage: z.literal('unavailable'),
});
