import type {ChildProcess} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {IterisConfig, Ticket} from '../types.js';
import {redact, registerSecret} from '../harness/redact.js';
import {runHarness} from '../harness/process.js';
import {captureContext, assertSnapshot, createSnapshot, digest, validateLocation, suggestChecks, type ReviewContext} from '../review/context.js';
import {runCommand} from '../review/command.js';
import {reviewPrompt, verificationPrompt, repairPrompt, recoveryPrompt} from '../review/prompts.js';
import {saveJson, finishReport, loadPassedReview, previousEvidence} from '../review/report.js';
import {reviewSettings, passSchema, verificationSchema, recoverySchema, parseReport, blocks, type ReviewPass, type Finding, type ReviewReport, type ReviewResult} from '../review/schema.js';

type ReviewOptions = {
	ticket: Ticket; config: IterisConfig; cwd: string; folder: string; plan?: string; branch?: string;
	onLogLine: (line: string) => void; onProcess: (proc: ChildProcess) => void; signal?: AbortSignal;
	audit?: boolean;
};

export async function runCodeReview(options: ReviewOptions): Promise<ReviewResult> {
	const {ticket, config, cwd, folder, signal, onProcess, audit} = options;
	if (config.custom) registerSecret(process.env[config.custom.apiKeyEnv]);
	const settings = reviewSettings(config.review);
	const directory = path.join(folder, 'review');
	const attempt = path.join(directory, 'attempts', randomUUID());
	await mkdir(attempt, {recursive: true});
	const started = Date.now();
	const deadline = started + Math.min(config.timeout, settings.timeout ?? (settings.mode === 'deep' ? 1800 : 900)) * 1000;
	const report: ReviewReport = {version: 1, outcome: 'incomplete', reason: 'Review not completed', startedAt: new Date(started).toISOString(), finishedAt: '', rounds: 0, repairs: 0,
		findings: [], requirements: [], checks: [], gaps: [], mode: settings.mode,
		selection: {harness: config.harness, model: config.harnesses[config.harness].model, effort: config.harnesses[config.harness].effort}, usage: 'unavailable'};
	const log = (line: string) => options.onLogLine(redact(`[review] ${line}`));
	const remaining = () => {if (signal?.aborted) throw new Error('Cancelled'); if (Date.now() >= deadline) throw new Error('Review deadline exceeded'); return deadline - Date.now();};
	const finish = () => finishReport(directory, attempt, report);
	try {
		let previousBlockers: Finding[] = [];
		let lastFailure = '';
		const additionalChecks = new Set<string>();
		const requiredRequirements = new Set<string>();
		for (let round = 0; round <= settings.maxRepairCycles; round++) {
			remaining();
			const context = captureContext(ticket, config, cwd, options.plan, options.branch);
			report.stamp = context.stamp;
			if (round === 0 && !audit) {
				const cached = await loadPassedReview(directory, context);
				if (cached && (config.qualityChecks.length || settings.allowNoChecks)) {log(`Reusing verified review of ${context.stamp.head}`); return cached;}
			}
			if (round === 0) {
				const previous = await previousEvidence(directory, context);
				if (previous) {
					report.findings = previous.findings;
					previousBlockers = previous.findings.filter(blocks);
					for (const requirement of previous.requirements) requiredRequirements.add(requirement.requirement);
				}
			}
			report.rounds++; report.checks = []; report.gaps = [];
			const roundFolder = path.join(attempt, `round-${round + 1}`);
			await saveJson(path.join(roundFolder, 'context.json'), context);
			await saveJson(path.join(directory, 'context.json'), context);
			if (!context.checks.length && !settings.allowNoChecks) {
				const suggested = suggestChecks(cwd, context.stamp.head);
				throw new Error(`No qualityChecks configured. ${suggested.length ? `Suggested qualityChecks: ${JSON.stringify(suggested)}. ` : ''}Configure repository checks, or explicitly set review.allowNoChecks for a change that needs none.`);
			}
			log(`Round ${round + 1}: checking ${context.stamp.head.slice(0, 12)}`);
			for (const command of [...context.checks, ...[...additionalChecks].filter(command => !context.checks.includes(command))]) {
				remaining();
				const result = await runCommand(command, [], {cwd, deadline, signal, shell: true});
				report.checks.push({command, head: context.stamp.head, ...result});
				await saveJson(path.join(roundFolder, 'checks.json'), report.checks);
				log(`${command}: ${result.error ?? `exit ${result.exitCode}`}`);
				assertSnapshot(context, config, cwd);
				if (result.error || result.exitCode === null) throw new Error(result.error ?? 'Check did not exit normally');
			}
			await saveJson(path.join(directory, 'checks.json'), report.checks);
			const snapshot = await createSnapshot(cwd, context.stamp.head, deadline, signal);
			let passes: ReviewPass[];
			let candidates: Finding[] = [];
			try {
				const runPass = async (lens: 'correctness' | 'maintainability' | 'risk') => {
					log(`Investigating ${lens}`);
					const result = await runHarness({config, phase: 'review', prompt: redact(reviewPrompt(lens, context, report.checks)), cwd: snapshot.cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[${lens}] ${line}`)});
					await saveJson(path.join(roundFolder, `${lens}-process.json`), result);
					if (!result.success) throw new Error(result.error ?? `${lens} reviewer failed`);
					const pass = parseReport(result.finalText ?? result.text, passSchema);
					if (pass.head !== context.stamp.head) throw new Error(`${lens} review returned the wrong commit.`);
					await saveJson(path.join(roundFolder, `${lens}.json`), pass);
					return pass;
				};
				// Wait for both even on failure, so no sibling outlives its disposable snapshot.
				const investigated = await Promise.allSettled([runPass('correctness'), runPass('maintainability')]);
				passes = investigated.map(result => {if (result.status === 'rejected') throw result.reason; return result.value;});
				if (settings.mode === 'deep' || context.risk.length) {report.mode = 'deep'; passes.push(await runPass('risk'));}
				for (const pass of passes) for (const requirement of pass.requirements) requiredRequirements.add(requirement.requirement);
				report.requirements = passes.flatMap(pass => pass.requirements);
				const gaps = passes.flatMap((pass, index) => passGaps(pass, context, ['correctness', 'maintainability', 'risk'][index]!));
				if (gaps.length) throw new ReviewGap(gaps.join('; '));
				const unique = new Map<string, Finding>();
				for (const candidate of passes.flatMap(pass => pass.findings)) {
					validateLocation(candidate, context, cwd);
					const id = digest([candidate.category, candidate.file, candidate.title, candidate.trigger]).slice(0, 16);
					const previous = unique.get(id);
					const rank = ['critical', 'high', 'medium', 'low'];
					const priority = previous && rank.indexOf(previous.priority) < rank.indexOf(candidate.priority) ? previous.priority : candidate.priority;
					unique.set(id, {...candidate, priority, materialRegression: candidate.materialRegression || Boolean(previous?.materialRegression), id, head: context.stamp.head, status: 'candidate'});
				}
				candidates = [...unique.values()];
				const verified = await runHarness({config, phase: 'review', prompt: redact(verificationPrompt(context, report.checks, passes, candidates, previousBlockers, [...requiredRequirements])), cwd: snapshot.cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[verify] ${line}`)});
				await saveJson(path.join(roundFolder, 'verification-process.json'), verified);
				if (!verified.success) throw new Error(verified.error ?? 'Verifier failed');
				const verification = parseReport(verified.finalText ?? verified.text, verificationSchema);
				await saveJson(path.join(roundFolder, 'verification.json'), verification);
				if (verification.head !== context.stamp.head) throw new Error('Verifier returned the wrong commit.');
				for (const requirement of verification.requirements) requiredRequirements.add(requirement.requirement);
				report.requirements = verification.requirements;
				if (!verification.complete || verification.gaps.length) throw new ReviewGap(`Verification incomplete: ${verification.gaps.join('; ') || 'missing coverage'}`);
				if (verification.decisions.length !== candidates.length || new Set(verification.decisions.map(d => d.id)).size !== candidates.length || verification.decisions.some(d => !candidates.some(f => f.id === d.id))) throw new Error('Verifier must decide every candidate exactly once.');
				if ([...requiredRequirements].some(req => !verification.requirements.some(v => v.requirement === req))) throw new Error('Verifier omitted an acceptance requirement.');
				for (const decision of verification.decisions) {
					const finding = candidates.find(f => f.id === decision.id)!;
					if (decision.duplicateOf && (decision.status !== 'confirmed' || decision.duplicateOf === decision.id || !verification.decisions.some(d => d.id === decision.duplicateOf && d.status === 'confirmed' && !d.duplicateOf))) throw new Error('Invalid duplicate finding reference.');
					Object.assign(finding, {status: decision.status, verification: decision.evidence, duplicateOf: decision.duplicateOf});
				}
				for (const finding of candidates) {
					if (finding.duplicateOf && blocks({...finding, duplicateOf: undefined}) && !blocks(candidates.find(f => f.id === finding.duplicateOf)!)) throw new Error('Deduplication cannot downgrade a blocking finding.');
				}
				if (new Set(verification.resolved.map(f => f.id)).size !== verification.resolved.length || verification.resolved.some(f => !previousBlockers.some(p => p.id === f.id) || candidates.some(c => c.id === f.id && c.status === 'confirmed'))) throw new Error('Invalid resolution evidence.');
				for (const previous of previousBlockers) {
					const resolved = verification.resolved.find(item => item.id === previous.id);
					if (resolved && previous.head === context.stamp.head) throw new Error('A blocker cannot be fixed without a new commit.');
					if (resolved) {previous.status = 'fixed'; previous.fixedAt = context.stamp.head; previous.verification = resolved.evidence;}
					else if (!candidates.some(c => c.id === previous.id && c.status === 'confirmed')) throw new Error(`Previous blocker ${previous.id} lacks resolution evidence.`);
				}
				report.findings = [...report.findings.filter(f => f.status === 'fixed' || !candidates.some(c => c.id === f.id)), ...candidates];
			} catch (error) {
				if (!(error instanceof ReviewGap)) throw error;
				report.gaps.push(error.message);
			} finally {await snapshot.dispose();}
			assertSnapshot(context, config, cwd); remaining();
			await saveJson(path.join(roundFolder, 'findings.json'), report.findings);
			await saveJson(path.join(directory, 'findings.json'), report.findings);
			for (const requirement of report.requirements.filter(r => r.status === 'unverified')) report.gaps.push(`${requirement.requirement}: ${requirement.evidence}`);
			previousBlockers = report.findings.filter(blocks);
			if (report.gaps.length) {
				report.outcome = 'incomplete'; report.reason = report.gaps.join('; ');
				const failureKey = digest({gaps: [...report.gaps].sort()});
				if (audit || round === settings.maxRepairCycles || failureKey === lastFailure) {log(report.reason); return finish();}
				lastFailure = failureKey; report.repairs++;
				log(`Recovery ${report.repairs}/${settings.maxRepairCycles}: ${report.reason}`);
				const recovered = await runHarness({config, phase: 'repair', prompt: redact(recoveryPrompt(context, report.gaps, report.requirements, report.checks, previousBlockers)), cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[recovery] ${line}`)});
				await saveJson(path.join(roundFolder, 'recovery-process.json'), recovered);
				if (!recovered.success) throw new Error(recovered.error ?? 'Recovery failed');
				const recovery = parseReport(recovered.finalText ?? recovered.text, recoverySchema);
				await saveJson(path.join(roundFolder, 'recovery.json'), recovery);
				const next = captureContext(ticket, config, cwd, options.plan, options.branch);
				if (next.stamp.base !== context.stamp.base) throw new Error('Base changed during recovery; restart review.');
				if (recovery.blockedReason) throw new Error(`Review recovery blocked: ${recovery.blockedReason}`);
				for (const command of recovery.checks) additionalChecks.add(command);
				continue;
			}
			previousBlockers = candidates.filter(blocks);
			const failedChecks = report.checks.filter(check => check.exitCode !== 0);
			const missing = report.requirements.filter(r => r.status === 'missing');
			if (!previousBlockers.length && !failedChecks.length && !missing.length) {
				report.outcome = 'passed'; report.reason = 'Required reviews and validation completed on the final commit.'; log(report.reason); assertSnapshot(context, config, cwd); return finish();
			}
			report.outcome = 'blocked'; report.reason = `${previousBlockers.length} blocking findings, ${missing.length} missing requirements, ${failedChecks.length} failed checks.`;
			const failureKey = digest({findings: previousBlockers.map(f => f.id).sort(), missing: missing.map(r => r.requirement).sort(), checks: failedChecks.map(c => c.command)});
			if (audit || round === settings.maxRepairCycles || failureKey === lastFailure) {log(report.reason); return finish();}
			lastFailure = failureKey; report.repairs++;
			log(`Repair ${report.repairs}/${settings.maxRepairCycles}: ${report.reason}`);
			const repaired = await runHarness({config, phase: 'repair', prompt: redact(repairPrompt(context, previousBlockers, missing, failedChecks)), cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[repair] ${line}`)});
			await saveJson(path.join(roundFolder, 'repair.json'), repaired);
			if (!repaired.success || !repaired.done) throw new Error(repaired.error ?? 'Repair did not report completion');
			const next = captureContext(ticket, config, cwd, options.plan, options.branch);
			if (next.stamp.head === context.stamp.head) {report.reason += ' Repair produced no new commit.'; return finish();}
			if (next.stamp.base !== context.stamp.base) throw new Error('Base changed during repair; restart review.');
		}
	} catch (error) {
		report.outcome = 'incomplete'; report.reason = error instanceof Error ? error.message : String(error); report.gaps.push(report.reason); log(report.reason);
	}
	return finish();
}

class ReviewGap extends Error {}

function passGaps(pass: ReviewPass, context: ReviewContext, lens: string): string[] {
	const gaps = [...pass.gaps];
	if (!pass.complete && !gaps.length) gaps.push('reviewer reported incomplete coverage');
	const missing = context.changedFiles.filter(file => !pass.inspectedFiles.includes(file));
	if (missing.length) gaps.push(`missing file coverage: ${missing.join(', ')}`);
	if (lens === 'correctness' && !pass.requirements.length) gaps.push('Correctness review omitted ticket acceptance criteria.');
	return gaps.map(gap => `${lens} review incomplete: ${gap}`);
}
