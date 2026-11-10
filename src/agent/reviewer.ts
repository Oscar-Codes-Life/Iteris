import type {ChildProcess} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import type {IterisConfig, Ticket} from '../types.js';
import {redact, registerSecret} from '../harness/redact.js';
import {runHarness} from '../harness/process.js';
import {parseOrRecoverReport} from './schema-recovery.js';
import {captureContext, assertSnapshot, createSnapshot, digest, validateLocation, suggestChecks, type ReviewContext} from '../review/context.js';
import {runCommand} from '../review/command.js';
import {reviewPrompt, verificationPrompt, repairPrompt, recoveryPrompt} from '../review/prompts.js';
import {saveJson, finishReport, loadPassedReview, previousEvidence, loadCheckpoint, saveCheckpoint, checksSchema} from '../review/report.js';
import {reviewSettings, passSchema, verificationSchema, recoverySchema, blocks, checkOk, type ReviewPass, type Finding, type ReviewReport, type ReviewResult} from '../review/schema.js';
import {applicableChecks} from '../lifecycle/requirements.js';
import {executeCommand,CapabilityUnavailable} from '../lifecycle/environment.js';
import {runRecoveryCheck} from '../lifecycle/local-check.js';
import {commitSourceChanges} from '../lifecycle/commit.js';

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
	// Each phase gets a quarter of the task allowance unless configured: a fixed 15 minutes
	// cannot hold a large repository's full test suite or a high-effort reviewer.
	const phaseBudget = Math.min(config.timeout, settings.timeout ?? Math.max(settings.mode === 'deep' ? 1800 : 900, Math.floor(config.timeout / 4))) * 1000;
	const overallDeadline = config._deadline ?? started + config.timeout * 1000;
	const repairDeadline = overallDeadline - config.timeout * 1000 * config.recovery.finalVerificationReserve;
	let deadline = Math.min(started + phaseBudget, overallDeadline);
	let phase = 'setup';
	const report: ReviewReport = {version: 1, outcome: 'incomplete', reason: 'Review not completed', startedAt: new Date(started).toISOString(), finishedAt: '', rounds: 0, repairs: 0,
		findings: [], requirements: [], checks: [], gaps: [], mode: settings.mode,
		selection: {harness: config.harness, model: config.harnesses[config.harness].model, effort: config.harnesses[config.harness].effort}, usage: 'unavailable'};
	const log = (line: string) => options.onLogLine(redact(`[review] ${line}`));
	const remaining = () => {if (signal?.aborted) throw new Error('Cancelled'); if (Date.now() >= deadline) throw new Error(`${phase} deadline exceeded`); return deadline - Date.now();};
	const beginPhase = (name: string) => {
		if (signal?.aborted) throw new Error('Cancelled');
		if (Date.now() >= overallDeadline) throw new Error('Review total deadline exceeded');
		phase = name; deadline = Date.now() + phaseBudget;
		deadline = Math.min(deadline, overallDeadline);
		log(`${name}: time allowance ${phaseBudget / 1000}s`);
	};
	const runStructuredReview = async <T>(name: string, prompt: string, schema: z.ZodType<T>, snapshotCwd: string, roundFolder: string): Promise<T> => {
		const result = await runHarness({config, phase: 'review', prompt: redact(prompt), cwd: snapshotCwd, timeoutMs: remaining(), signal, onProcess,
			onLine: line => log(`[${name === 'verification' ? 'verify' : name}] ${line}`)});
		await saveJson(path.join(roundFolder, `${name}-process-attempt-1.json`), result);
		if (!result.success) throw new Error(`${name}: ${result.error ?? 'reviewer failed'}`);
		const parsed = await parseOrRecoverReport({config, reportType: name, originalPrompt: prompt, raw: result.finalText ?? result.text, schema, cwd: snapshotCwd,
			remaining, signal, onProcess, onLine: log, onAttempt: (index, recovery) => saveJson(path.join(roundFolder, `${name}-schema-recovery-attempt-${index}.json`), recovery)});
		await saveJson(path.join(roundFolder, `${name}-process.json`), result);
		return parsed;
	};
	type Dependency = NonNullable<ReviewReport['dependencies']>[number];
	// Host facts (missing isolation) stay blocking. Model-raised evidence that needs a device, hosted
	// service or missing attachment is a follow-up; workflow.externalEvidence decides whether it blocks.
	const capability: Dependency[] = [];
	const raised = new Map<string, Dependency>();
	const advisory = config.workflow.externalEvidence === 'advisory';
	const finish = () => {
		const manual = report.requirements.filter(item => item.status === 'external').map((item): Dependency => ({id: `manual-${digest(item.requirement).slice(0, 12)}`, kind: 'external',
			description: `${item.requirement} — ${item.evidence}`.slice(0, 1500), nextAction: 'Verify manually outside the local checkout'}));
		const all = new Map([...capability, ...raised.values(), ...manual].map(dependency => [dependency.id, dependency]));
		if (all.size) report.dependencies = [...all.values()]; else delete report.dependencies;
		return finishReport(directory, attempt, report);
	};
	try {
		let previousBlockers: Finding[] = [];
		const repairAttempts = new Map<string, number>();
		let codeSpent=0,budgetKey='';
		const canRepair = (key: string,code=false) => {
			if (audit || !config.recovery.enabled || settings.maxRepairCycles === 0 || report.repairs >= config.recovery.attempts || Date.now() >= repairDeadline) return false;
			if(code && codeSpent>=config.recovery.attempts)return false;
			const attempts = repairAttempts.get(key) ?? 0;
			if (attempts >= settings.maxRepairCycles) return false;
			repairAttempts.set(key, attempts + 1);
			if(code)codeSpent++;
			return true;
		};
		const additionalChecks = new Set<string>();
		let unresolvedRequirements = new Set<string>();
		for (let round = 0; ; round++) {
			beginPhase('Checks');
			const requiredRequirements = new Set(unresolvedRequirements);
			const context = captureContext(ticket, config, cwd, options.plan, options.branch);
			for(const requirement of context.requirements.filter(r=>r.stage==='local' && r.id!=='local-checks'))requiredRequirements.add(requirement.text);
			// The host decides its own gates and later stages from its own evidence. A reviewer's
			// opinion of them (always "unverified" before publication) is never a review gap.
			const hostOwned = new Set(context.requirements.filter(r => r.stage !== 'local' || r.id === 'local-checks').map(r => r.text));
			const own = <T extends {requirement: string}>(items: T[]) => items.filter(item => !hostOwned.has(item.requirement));
			const required = () => [...requiredRequirements].filter(text => !hostOwned.has(text));
			const followUps = () => [...raised.values()].map(dependency => dependency.description);
			let resume = false;
			const supplementalKey = digest(['supplemental-checks', context.stamp.scope]);
			report.stamp = context.stamp;
			if (round === 0 && !audit) {
				budgetKey=digest(['repair-budget',context.stamp.scope]);
				const budget=await loadCheckpoint(directory,budgetKey,z.object({spent:z.number().int().nonnegative(),attempts:z.record(z.number().int().nonnegative())}));
				if(budget){codeSpent=budget.spent;for(const [key,attempts] of Object.entries(budget.attempts))repairAttempts.set(key,attempts);}
				const cached = await loadPassedReview(directory, context, advisory);
				if (cached && (config.qualityChecks.length || context.checkIds.length || settings.allowNoChecks)) {log(`Reusing verified review of ${context.stamp.head}`); return cached;}
			}
			if (round === 0) {
				const previous = await previousEvidence(directory, context);
				if (previous) {
					resume = !audit && previous.outcome === 'incomplete';
					report.findings = previous.findings;
					previousBlockers = previous.findings.filter(blocks);
					for (const requirement of own(previous.requirements).filter(item => item.status !== 'covered')) requiredRequirements.add(requirement.requirement);
				}
				// Also resume after a process crash before result.json could be written.
				if (!previous && !audit) resume = true;
				if (!audit) for (const command of await loadCheckpoint(directory, supplementalKey, recoverySchema.shape.checks.max(100)) ?? []) additionalChecks.add(command);
			}
			report.rounds++; report.checks = []; report.gaps = [];
			const roundFolder = path.join(attempt, `round-${round + 1}`);
			await saveJson(path.join(roundFolder, 'context.json'), context);
			await saveJson(path.join(directory, 'context.json'), context);
			const namedChecks = applicableChecks(config, context.changedFiles);
			if (!context.checks.length && !namedChecks.length && !settings.allowNoChecks) {
				const suggested = suggestChecks(cwd, context.stamp.head);
				throw new Error(`No qualityChecks configured. ${suggested.length ? `Suggested qualityChecks: ${JSON.stringify(suggested)}. ` : ''}Configure repository checks, or explicitly set review.allowNoChecks for a change that needs none.`);
			}
			log(`Round ${round + 1}: checking ${context.stamp.head.slice(0, 12)}`);
			const commands = [...context.checks, ...[...additionalChecks].filter(command => !context.checks.includes(command)), ...namedChecks.map(check => `check:${check.id}`)];
			const checksKey = digest(['checks', context.stamp.key, commands]);
			// Later rounds on an unchanged commit and command list reuse the same host evidence.
			const cachedChecks = resume || round > 0 ? await loadCheckpoint(directory, checksKey, checksSchema) : undefined;
			if (cachedChecks && cachedChecks.length === commands.length && cachedChecks.every((check, index) => check.command === commands[index] && check.head === context.stamp.head && checkOk(check))) {
				report.checks = cachedChecks;
				log(`Reusing successful checks for ${context.stamp.head.slice(0, 12)}`);
			} else for (const command of commands) {
				remaining();
				const named = namedChecks.find(check => command === `check:${check.id}`);
				let result;
				// Commands proposed by a planner or recovery instance run isolated; configured checks are trusted.
				const suggested = !named && (config._plannedChecks?.includes(command) || (additionalChecks.has(command) && !config.qualityChecks.includes(command)));
				try{result = named ? await executeCommand(named.command, cwd, {...config, _deadline:deadline}, signal) : suggested ? await runRecoveryCheck(command,cwd,config,deadline,signal) : await runCommand(command, [], {cwd, deadline, signal, shell: true, env:{...process.env,...config._execution?.env,PATH:config._execution?.path ?? process.env['PATH']}});}
				catch(error){if(!(error instanceof CapabilityUnavailable))throw error;if(!capability.some(d=>d.id===error.dependency))capability.push({id:error.dependency,kind:'capability',description:error.message,nextAction:error.nextAction});result={exitCode:null,output:'',durationMs:0,truncated:false,error:error.message};}
				const {stdout:_stdout,stderr:_stderr,...checkResult}=result;
				// A suggested command whose tool is not installed here (adb, a device runner) never started.
				// That is absent evidence for the reviewers to weigh, not a failing project check.
				const unavailable = suggested && !config.qualityChecks.includes(command) && !result.error && (result.exitCode === 127 || result.exitCode === 126);
				report.checks.push({command, head: context.stamp.head, ...checkResult, ...(unavailable ? {unavailable: true} : {})});
				await saveJson(path.join(roundFolder, 'checks.json'), report.checks);
				log(`${command}: ${unavailable ? `not run, tool unavailable on this host (exit ${result.exitCode})` : result.error ?? `exit ${result.exitCode}`}`);
				assertSnapshot(context, config, cwd);
				if(signal?.aborted)throw new Error('Cancelled');
			}
			await saveJson(path.join(roundFolder, 'checks.json'), report.checks);
			await saveJson(path.join(directory, 'checks.json'), report.checks);
			if (!audit && report.checks.every(checkOk)) await saveCheckpoint(directory, checksKey, report.checks);
			assertSnapshot(context, config, cwd);
			beginPhase('Investigation');
			const snapshot = await createSnapshot(cwd, context.stamp.head, deadline, signal, context.diff);
			let passes: ReviewPass[];
			let candidates: Finding[] = [];
			try {
				const runPass = async (lens: 'correctness' | 'maintainability' | 'risk') => {
					const key = digest(['investigation', context.stamp.key, lens, report.checks]);
					let cached = resume || round > 0 ? await loadCheckpoint(directory, key, passSchema) : undefined;
					if(cached && (!cached.complete || cached.gaps.length || own(cached.requirements).some(r=>r.status==='unverified') || context.changedFiles.some(file=>!cached!.inspectedFiles.includes(file))))cached=undefined;
					try {for (const candidate of cached?.findings ?? []) validateLocation(candidate, context, cwd);} catch {cached = undefined;}
					if (cached && cached.head === context.stamp.head) {
						log(`Reusing ${lens} investigation for ${context.stamp.head.slice(0, 12)}`);
						await saveJson(path.join(roundFolder, `${lens}.json`), cached);
						return cached;
					}
					log(`Investigating ${lens}`);
					const pass = await runStructuredReview(lens, reviewPrompt(lens, context, report.checks, followUps()), passSchema, snapshot.cwd, roundFolder);
					if (pass.head !== context.stamp.head) throw new Error(`${lens} review returned the wrong commit.`);
					for (const candidate of pass.findings) validateLocation(candidate, context, cwd);
					await saveJson(path.join(roundFolder, `${lens}.json`), pass);
					if (!audit && pass.complete && !pass.gaps.length && own(pass.requirements).every(r=>r.status!=='unverified')) await saveCheckpoint(directory, key, pass);
					return pass;
				};
				const lenses: Array<'correctness' | 'maintainability' | 'risk'> = ['correctness', 'maintainability'];
				if (settings.mode === 'deep' || context.risk.length) {report.mode = 'deep'; lenses.push('risk');}
				// All required investigators start together. Drain all before disposing their snapshot.
				const investigated = await Promise.allSettled(lenses.map(runPass));
				if (investigated[0]?.status === 'fulfilled') for (const requirement of own(investigated[0].value.requirements)) requiredRequirements.add(requirement.requirement);
				report.requirements = own(investigated.flatMap(result => result.status === 'fulfilled' ? result.value.requirements : []));
				passes = investigated.map(result => {if (result.status === 'rejected') throw result.reason; return result.value;});
				const unique = new Map<string, Finding>();
				for (const candidate of passes.flatMap(pass => pass.findings)) {
					validateLocation(candidate, context, cwd);
					const id = digest([candidate.category, candidate.file, candidate.title, candidate.trigger]).slice(0, 16);
					const previous = unique.get(id);
					const rank = ['critical', 'high', 'medium', 'low'];
					const priority = previous && rank.indexOf(previous.priority) < rank.indexOf(candidate.priority) ? previous.priority : candidate.priority;
					unique.set(id, {...candidate, priority, policyRule:[...new Set([candidate.policyRule,previous?.policyRule].filter(Boolean))].join('\n'), materialRegression: candidate.materialRegression || Boolean(previous?.materialRegression), id, head: context.stamp.head, status: 'candidate'});
				}
				candidates = [...unique.values()];
				await saveJson(path.join(roundFolder, 'candidates.json'), candidates);
				const gaps = passes.flatMap((pass, index) => passGaps(pass, context, lenses[index]!));
				if (gaps.length) throw new ReviewGap(gaps.join('; '));
				assertSnapshot(context, config, cwd);
				beginPhase('Verification');
				const verification = await runStructuredReview('verification', verificationPrompt(context, report.checks, passes, candidates, previousBlockers, required(), followUps()), verificationSchema, snapshot.cwd, roundFolder);
				await saveJson(path.join(roundFolder, 'verification.json'), verification);
				if (verification.head !== context.stamp.head) throw new Error('Verifier returned the wrong commit.');
				for (const requirement of own(verification.requirements)) requiredRequirements.add(requirement.requirement);
				report.requirements = own(verification.requirements);
				if (!verification.complete || verification.gaps.length) throw new ReviewGap(`Verification incomplete: ${verification.gaps.join('; ') || 'missing coverage'}`);
				if (verification.decisions.length !== candidates.length || new Set(verification.decisions.map(d => d.id)).size !== candidates.length || verification.decisions.some(d => !candidates.some(f => f.id === d.id))) throw new Error('Verifier must decide every candidate exactly once.');
				if (required().some(req => !verification.requirements.some(v => v.requirement === req))) throw new Error('Verifier omitted an acceptance requirement.');
				for (const decision of verification.decisions) {
					const finding = candidates.find(f => f.id === decision.id)!;
					let duplicateOf = decision.duplicateOf;
					if (decision.status === 'duplicate' && !duplicateOf) {
						const referenced = verification.decisions.filter(other => other.id !== decision.id && other.status === 'confirmed' && decision.evidence.includes(other.id));
						if (referenced.length === 1) duplicateOf = referenced[0]!.id;
					}
					// An uncertain duplicate remains an unresolved finding rather than
					// dropping an obligation or stopping before available repair.
					if (decision.status === 'duplicate' && !duplicateOf) Object.assign(finding,{status:'confirmed',verification:decision.evidence});
					if (decision.status === 'rejected' && duplicateOf) throw new Error('Rejected decisions cannot reference a canonical finding.');
					if (duplicateOf && (duplicateOf === decision.id || !verification.decisions.some(d => d.id === duplicateOf && d.status === 'confirmed' && !d.duplicateOf))) throw new Error('Invalid duplicate finding reference.');
					Object.assign(finding, {status: decision.status === 'duplicate' ? 'confirmed' : decision.status, verification: decision.evidence, duplicateOf});
				}
				for (const finding of candidates) {
					if (!finding.duplicateOf) continue;
					const canonical = candidates.find(f => f.id === finding.duplicateOf)!;
					const rank = ['critical','high','medium','low'];
					if (rank.indexOf(finding.priority) < rank.indexOf(canonical.priority)) canonical.priority = finding.priority;
					canonical.materialRegression ||= finding.materialRegression;
					if (finding.category === 'acceptance') canonical.category = 'acceptance';
					if (finding.policyRule) canonical.policyRule = [...new Set([canonical.policyRule,finding.policyRule].filter(Boolean))].join('\n');
					// Preserve each blocking obligation when the canonical category differs.
					if (blocks({...finding,duplicateOf:undefined}) && !blocks(canonical)) finding.duplicateOf = undefined;
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
			assertSnapshot(context, config, cwd);
			if (signal?.aborted) throw new Error('Cancelled');
			await saveJson(path.join(roundFolder, 'findings.json'), report.findings);
			await saveJson(path.join(directory, 'findings.json'), report.findings);
			for (const requirement of report.requirements.filter(r => r.status === 'unverified')) report.gaps.push(`${requirement.requirement}: ${requirement.evidence}`);
			previousBlockers = report.findings.filter(blocks);
			if (report.gaps.length) {
				unresolvedRequirements = new Set(report.requirements.filter(item => item.status !== 'covered').map(item => item.requirement));
					report.outcome = 'incomplete'; report.reason = report.gaps.join('; ');
				const failureKey = digest({kind:'review-gap', files:context.changedFiles, candidates:candidates.map(f=>[f.category,f.file,f.line,f.policyRule]).sort()});
				if (!canRepair(failureKey)) {
					if (!audit && report.gaps.every(namesCiGate) && ciDeferralReady(report, candidates)) {
						report.deferredToCI = true;
						report.reason = `CI evidence pending: ${report.reason}`;
					}
					log(report.reason); return finish();
				}
				report.repairs++;
				log(`Recovery ${report.repairs}: ${report.reason}`);
				beginPhase('Recovery');
				const repeated=(repairAttempts.get(failureKey)??0)>1;
				const prompt = recoveryPrompt(context, report.gaps, report.requirements, report.checks, previousBlockers, candidates,repeated?'This invariant remains unresolved after recovery. Replan from the recorded failure: trace why the prior strategy failed and choose a different local reproduction or setup approach. Keep the same acceptance obligation and budget.':'');
				if(repeated)await saveJson(path.join(roundFolder,'replanning.json'),{signature:failureKey,head:context.stamp.head,attempt:repairAttempts.get(failureKey),progressMetric:'Available local commands execute successfully; independent coverage resolves the same invariant',reason:report.reason});
				const recovered = await runHarness({config, phase: 'repair', prompt: redact(prompt), cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[recovery] ${line}`)});
				await saveJson(path.join(roundFolder, 'recovery-process.json'), recovered);
				if (!recovered.success) throw new Error(recovered.error ?? 'Recovery failed');
				const recovery = await parseOrRecoverReport({config, reportType: 'recovery', originalPrompt: prompt, raw: recovered.finalText ?? recovered.text,
					schema: recoverySchema, cwd, remaining, signal, onProcess, onLine: log,
					onAttempt: (index, correction) => saveJson(path.join(roundFolder, `recovery-schema-recovery-attempt-${index}.json`), correction)});
				await saveJson(path.join(roundFolder, 'recovery.json'), recovery);
				commitSourceChanges(cwd,context.stamp.branch,'Recover project verification');
				const next = captureContext(ticket, config, cwd, options.plan, options.branch);
				if (next.stamp.base !== context.stamp.base) throw new Error('Base changed during recovery; restart review.');
				// A model cannot declare a host capability missing; whatever it names is an external follow-up.
				const known = raised.size;
				for (const dependency of recovery.dependencies?.length ? recovery.dependencies : recovery.blockedReason ? [{id:namesCiGate(recovery.blockedReason)?'ci':'recovery-capability',kind:'external' as const,description:recovery.blockedReason,nextAction:'Refresh the dependency or configure a verification probe, then resume'}] : [])
					raised.set(dependency.id, {...dependency, kind: 'external'});
				if (recovery.deferredToCI || namesCiGate(recovery.blockedReason ?? '')) report.deferredToCI = true;
				const checkCount = additionalChecks.size;
				for (const command of recovery.checks) additionalChecks.add(command);
				// Newly recorded follow-ups are handed to the reviewers once, so the next round judges
				// only what a local checkout can show instead of ending on the same gap.
				const acknowledged = advisory && raised.size > known && !report.deferredToCI;
				if (next.stamp.head === context.stamp.head && additionalChecks.size === checkCount && !acknowledged) {
					report.reason += recovery.blockedReason ? ` External evidence pending: ${recovery.blockedReason}` : ' Recovery produced no new commit or check command.';
					log(report.reason); return finish();
				}
				await saveCheckpoint(directory, supplementalKey, [...additionalChecks]);
				continue;
			}
			previousBlockers = candidates.filter(blocks);
			const failedChecks = report.checks.filter(check => check.exitCode !== 0 && !check.unavailable);
			if(failedChecks.some(check=>check.exitCode===null) && capability.length){report.outcome='incomplete';report.reason='Local checks await the recorded execution capability';return finish();}
			const missing = report.requirements.filter(r => r.status === 'missing');
			unresolvedRequirements = new Set(report.requirements.filter(item => item.status !== 'covered').map(item => item.requirement));
			if (!previousBlockers.length && !failedChecks.length && !missing.length) {
				report.outcome = 'passed'; report.reason = 'Required reviews and validation completed on the final commit.'; log(report.reason); assertSnapshot(context, config, cwd); return finish();
			}
			report.outcome = 'blocked'; report.reason = `${previousBlockers.length} blocking findings, ${missing.length} missing requirements, ${failedChecks.length} failed checks.`;
			const failureKey = digest({findings: previousBlockers.map(f => [f.category,f.file,f.line,f.policyRule]).sort(), missing: missing.map(r => r.requirement).sort(), checks: failedChecks.map(c => c.command)});
			if (!canRepair(failureKey,true)) {log(report.reason); return finish();}
			await saveCheckpoint(directory,budgetKey,{spent:codeSpent,attempts:Object.fromEntries(repairAttempts)});
			report.repairs++;
			log(`Repair ${report.repairs}: ${report.reason}`);
			beginPhase('Repair');
			const repeated=(repairAttempts.get(failureKey)??0)>1;
			if(repeated)await saveJson(path.join(roundFolder,'replanning.json'),{signature:failureKey,head:context.stamp.head,attempt:repairAttempts.get(failureKey),progressMetric:'The same behavioral check and independent invariant become satisfied',reason:report.reason});
			const repaired = await runHarness({config, phase: 'repair', prompt: redact(repairPrompt(context, previousBlockers, missing, failedChecks,repeated?'The same invariant failed after a prior repair. Replan before editing: trace the root cause and why the prior patch failed, choose a different strategy, then demonstrate measurable progress with the failing behavioral check. Do not repeat the same patch or change the acceptance obligation.':'')), cwd, timeoutMs: remaining(), signal, onProcess, onLine: line => log(`[repair] ${line}`)});
			await saveJson(path.join(roundFolder, 'repair.json'), repaired);
			if (!repaired.success || !repaired.done) throw new Error(repaired.error ?? 'Repair did not report completion');
			commitSourceChanges(cwd,context.stamp.branch,'Repair verified project invariant');
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

function namesCiGate(reason: string): boolean {
	return /\b(?:CI|GitHub Actions|GitLab CI|CircleCI)\b/i.test(reason) && /\b(?:gate|check|job|workflow|pipeline|event)\b/i.test(reason);
}

function ciDeferralReady(report: ReviewReport, candidates: Finding[]): boolean {
	return candidates.length === 0 && report.requirements.length > 0 && report.checks.every(checkOk) &&
		!report.gaps.some(gap => /missing file coverage|omitted ticket acceptance criteria|reviewer reported incomplete coverage/i.test(gap)) &&
		!report.findings.some(finding => finding.status === 'candidate' || blocks(finding)) &&
		!report.requirements.some(requirement => requirement.status === 'missing');
}

function passGaps(pass: ReviewPass, context: ReviewContext, lens: string): string[] {
	const gaps = [...pass.gaps];
	if (!pass.complete && !gaps.length) gaps.push('reviewer reported incomplete coverage');
	const missing = context.changedFiles.filter(file => !pass.inspectedFiles.includes(file));
	if (missing.length) gaps.push(`missing file coverage: ${missing.join(', ')}`);
	if (lens === 'correctness' && !pass.requirements.length) gaps.push('Correctness review omitted ticket acceptance criteria.');
	return gaps.map(gap => `${lens} review incomplete: ${gap}`);
}
