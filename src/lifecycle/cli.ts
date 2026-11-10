import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { IterisConfig } from '../types.js';
import { listRuns, readRun, saveRun, renderRun, renderPrCompletion, type TaskRun } from './state.js';
import { prepareEnvironment, persistedManifest, resolveExecutable } from './environment.js';
import { runCommand } from '../review/command.js';
import { addEvidence } from './requirements.js';
import { runWorker } from './worker.js';
import { keepAwake } from '../harness/awake.js';
import { acquireRun, hasActiveRun } from '../state/active.js';
import { requestCancellation } from './cancellation.js';
import { resolveTaskConfig } from './config.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generatePrDescription } from '../agent/pr-description.js';
import { updatePrSections, listPlaceholderPrs, prChanges, updatePrBody, healPublishedBody, REVIEW_START, REVIEW_END } from '../github/pr.js';
import { loadReportText } from '../review/report.js';
export async function lifecycleCommand(command: string, args: string[], config: IterisConfig, cwd: string): Promise<boolean> {
    if (!['status', 'resume', 'doctor', 'evidence', 'cancel', 'describe'].includes(command))
        return false;
    if (command === 'status') {
        const runs = args[0] ? [await readRun(cwd, args[0])].filter(Boolean) : await listRuns(cwd, config.repo);
        for (const run of runs)
            if (run)
                console.log(`${run.key}\n${renderRun(run)}`);
        if (!runs.length)
            console.log('No persisted task runs.');
        return true;
    }
    if (command === 'describe') {
        const dryRun = args.includes('--dry-run'), all = args.includes('--all'), key = args.find(arg => !arg.startsWith('--'));
        if (key && all)
            throw new Error('Usage: iteris describe [task-key | --all] [--dry-run]');
        const published = (key ? [await readRun(cwd, key)] : await listRuns(cwd, config.repo)).filter((run): run is TaskRun => !!run?.publication && run.state !== 'cancelled');
        if (!published.length && !all)
            console.log(key ? 'That task has no published pull request.' : 'No published task runs.');
        // The saved run is rewritten, so a running queue must not be writing it at the same time.
        const release = dryRun ? undefined : await acquireRun(cwd);
        try {
            for (const run of published) {
                const publication = run.publication!, review = await loadReportText(path.join(run.artifacts, 'review'));
                const label = `${publication.url} — ${run.ticket.title}`;
                if (!review || review.report.outcome !== 'passed' || review.report.stamp?.head !== publication.head) {
                    console.log(`${label}\n  Skipped: no passed review for the published commit yet; Iteris writes the description when it passes.`);
                    continue;
                }
                try {
                    execFileSync('git', ['cat-file', '-e', `${publication.head}^{commit}`], { cwd, stdio: 'ignore' });
                }
                catch {
                    console.log(`${label}\n  Skipped: commit ${publication.head.slice(0, 9)} is not in this checkout; fetch the task branch and retry.`);
                    continue;
                }
                const snapshot = resolveTaskConfig(config, run.ticket);
                const described = await generatePrDescription({ ticket: run.ticket, config: snapshot, cwd, review: review.text, baseCommit: publication.base, branch: publication.head });
                if (!described.success || !described.text) {
                    console.log(`${label}\n  Failed: ${described.error ?? 'the harness produced no description'}`);
                    continue;
                }
                if (dryRun) {
                    console.log(`${label}\n\n${described.text}\n\n## Task completion\n${renderPrCompletion(run)}\n`);
                    continue;
                }
                await updatePrSections(snapshot, publication.number, { description: described.text, review: review.text, lifecycle: renderPrCompletion(run) });
                publication.described = publication.head;
                await saveRun(cwd, run);
                console.log(`${label}\n  Description rewritten.`);
            }
            if (all) {
                // Pull requests from earlier queues, merged or closed since, whose runs are no longer on this machine.
                const local = new Set((await listRuns(cwd, config.repo)).map(run => run.publication?.number));
                const remote = (await listPlaceholderPrs(config)).filter(pr => !local.has(pr.number));
                if (!remote.length)
                    console.log('No other pull request in this repository carries a placeholder description from Iteris.');
                for (const pr of remote) {
                    const label = `${pr.url} (${pr.state}) — ${pr.title}`;
                    try {
                        const reviewStart = pr.body.indexOf(REVIEW_START), reviewEnd = pr.body.indexOf(REVIEW_END, reviewStart);
                        // The ticket itself is gone; the checklist the placeholder kept is its text, line by line.
                        const requirements = [...pr.body.slice(0, reviewStart).matchAll(/^- \[[ x]\] (.+?) \((?:acceptance|plan)-[0-9a-f]+; [^)]*\)$/gm)].map(match => match[1]!);
                        const ticket = { number: pr.number, title: pr.title, body: requirements.join('\n') || '(not available)', slug: `pr-${pr.number}`, labels: [], htmlUrl: pr.url };
                        const described = await generatePrDescription({ ticket, config, cwd, review: pr.body.slice(reviewStart + REVIEW_START.length, reviewEnd).trim(), changes: await prChanges(config, pr.number) });
                        if (!described.success || !described.text) {
                            console.log(`${label}\n  Failed: ${described.error ?? 'the harness produced no description'}`);
                            continue;
                        }
                        if (dryRun) {
                            console.log(`${label}\n\n${described.text}\n`);
                            continue;
                        }
                        await updatePrBody(config, pr.number, healPublishedBody(pr.body, described.text));
                        console.log(`${label}\n  Description rewritten.`);
                    }
                    catch (error) {
                        console.log(`${label}\n  Failed: ${String(error)}`);
                    }
                }
            }
        }
        finally {
            await release?.();
        }
        return true;
    }
    if (command === 'doctor') {
        const snapshot = structuredClone(config);
        snapshot.recovery.enabled = false;
        const manifest = await prepareEnvironment(snapshot, cwd), executable = await resolveExecutable(config.harness, cwd, manifest.path);
        const harness = await runCommand(executable, ['--version'], { cwd, env: { ...process.env, PATH: manifest.path }, deadline: Date.now() + 30000 });
        console.log(JSON.stringify({ environment: persistedManifest(manifest), harness: { name: config.harness, executable, version: harness.output.trim(), available: harness.exitCode === 0 }, stages: config.verification.stages.map(stage => ({ id: stage.id, kind: stage.kind, verification: !!stage.verify, executionEnabled: config.integrations.externalActions.includes(stage.id) })) }, null, 2));
        return true;
    }
    if (command === 'resume') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.on('SIGINT', abort);
        process.on('SIGTERM', abort);
        try {
            keepAwake();
            await runWorker({ config, cwd, once: args.includes('--once'), force: true, signal: controller.signal, callbacks: { onStatusChange(_, state) { console.log(`${state.ticket.title}: ${state.status}${state.failureReason ? ` — ${state.failureReason}` : ''}`); }, onLogLine(_, line) { console.log(line); }, onComplete() { } } });
        }
        finally {
            process.off('SIGINT', abort);
            process.off('SIGTERM', abort);
        }
        return true;
    }
    const key = args[0];
    if (!key)
        throw new Error(`${command} requires a task key from iteris status`);
    if (!await readRun(cwd, key))
        throw new Error('Task run not found');
    if (command === 'cancel') {
        await requestCancellation(cwd, key);
        if (!await hasActiveRun(cwd)) {
            const release = await acquireRun(cwd);
            try {
                const run = (await readRun(cwd, key))!;
                run.state = 'cancelled';
                run.phase = 'cancelled';
                run.reason = 'Cancelled explicitly';
                await saveRun(cwd, run);
            }
            finally {
                await release();
            }
        }
        console.log('Cancellation recorded. The active task stops at the next cancellation checkpoint.');
        return true;
    }
    const filename = args[1];
    if (!filename)
        throw new Error('Usage: iteris evidence <task-key> <receipt.json>');
    const receipt = z.object({ version: z.literal(1), requirementId: z.string(), commit: z.string(), build: z.string().optional(), observedAt: z.string().datetime(), provenance: z.string().min(1), details: z.string().min(1), success: z.boolean() }).strict().parse(JSON.parse(await readFile(filename, 'utf8')));
    const release = await acquireRun(cwd);
    try {
        const run = (await readRun(cwd, key))!;
        const requirement = run.requirements.find(r => r.id === receipt.requirementId);
        if (!requirement || ['local', 'review', 'publication', 'ci'].includes(requirement.stage))
            throw new Error('Submitted evidence must reference an external acceptance requirement');
        if (receipt.commit !== (run.publication?.head ?? run.implementation?.head))
            throw new Error('Evidence references another commit');
        if (Date.parse(receipt.observedAt) > Date.now() + 60000)
            throw new Error('Evidence observation time is in the future');
        let files: string[] = [];
        try {
            files = JSON.parse(await readFile(path.join(run.artifacts, 'review', 'context.json'), 'utf8')).changedFiles ?? [];
        }
        catch { /* no published context */ }
        const snapshot = resolveTaskConfig(config, run.ticket, files), stage = snapshot.verification.stages.find(s => s.id === requirement.stage || s.kind === requirement.stage);
        const observations = run.evidence.filter(e => e.requirementId === receipt.requirementId && e.commit === receipt.commit && e.provenance === receipt.provenance && e.build === receipt.build);
        const failure = [...observations].reverse().find(e => e.positiveObservation === false);
        const previous = observations.find(e => (e.positiveObservation === true || e.success) && (!failure || Date.parse(e.observedAt) > Date.parse(failure.observedAt)));
        const observed = !stage?.observationSeconds || (previous && Date.parse(receipt.observedAt) - Date.parse(previous.observedAt) >= stage.observationSeconds * 1000);
        const success = receipt.success && !!observed;
        addEvidence(run, receipt.requirementId, receipt.commit, receipt.provenance, receipt.details, success, run.publication?.base, receipt.observedAt, receipt.build).positiveObservation = receipt.success;
        if (success)
            run.dependencies = run.dependencies.filter(d => d.id !== requirement.stage && d.id !== `stage:${requirement.stage}`);
        await saveRun(cwd, run);
        console.log('Evidence recorded. Run iteris resume --once to reconcile completion.');
        return true;
    }
    finally {
        await release();
    }
}
