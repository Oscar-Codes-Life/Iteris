import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteConfig} from '../dist/config.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {runHarness} from '../dist/harness/process.js';
import {ensureRun, saveRun, readRun, taskKey} from '../dist/lifecycle/state.js';
import {recordAttempt, attemptBriefing, renderAttempts, resumableBlocked, consumeRetry, countedFailures, awaitingPerson} from '../dist/lifecycle/attempts.js';
import {submitAnswer, takeAnswer, answerWaiting} from '../dist/lifecycle/answers.js';
import {runWorker, schedulingOrder, unfinishedTickets} from '../dist/lifecycle/worker.js';
import {advanceCompletion} from '../dist/lifecycle/stages.js';
import {addEvidence, extractRequirements} from '../dist/lifecycle/requirements.js';
import {ticketBranch} from '../dist/types.js';
import {temporary, environment, executable, config, fakeAgent, reviewRepository, completionServices} from './helpers.mjs';

const ticket = number => ({number, title: `Ticket ${number}`, body: 'Implement feature', slug: `ticket-${number}`, labels: [], htmlUrl: 'https://example.com/ticket'});
const quiet = {onStatusChange() {}, onLogLine() {}, onComplete() {}};
function services() {
	const prs = new Map(), created = [];
	return {created, prs, ci: async (_cfg, run) => ({state: 'passed', details: 'fixture required CI passed', head: run.publication.head, base: run.publication.base}), draft: async () => {},
		findPr: async (_config, branch) => prs.get(branch), createPr: async (_config, input) => {created.push(input); const pr = {url: 'https://example.com/pr', number: 5}; prs.set(input.branch, pr); return pr;},
		addLabel: async () => {}, moveCard: async () => {}};
}
const calls = async cwd => (await readFile(path.join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
async function blankRun(t) {
	const cwd = await temporary(t), cfg = config('codex'), task = ticket(1);
	return {cwd, cfg, run: await ensureRun(cwd, task, cfg, path.join(cwd, '.iteris/tasks/artifacts'), ticketBranch(task))};
}

test('a failed attempt is scheduled for a fresh instance with growing backoff', async t => {
	const {cfg, run} = await blankRun(t), now = Date.parse('2026-11-07T12:00:00Z');
	const first = recordAttempt(run, cfg, {phase: 'running', status: 'stale', kind: 'code', reason: 'Process stalled: no output for 1800s', logTail: ['[tool] Bash', 'npm test']}, now);
	assert.equal(first.disposition, 'retry'); assert.equal(run.state, 'waiting');
	assert.equal(run.dependencies.find(d => d.id === 'attempt').nextRetryAt, new Date(now + cfg.continuation.initialSeconds * 1000).toISOString());
	const second = recordAttempt(run, cfg, {phase: 'reviewing', status: 'blocked', kind: 'code', reason: 'Review blocked', details: ['high correctness finding at a.ts:1: Wrong'], needsRepair: true, head: 'abc'}, now);
	assert.equal(second.number, 2);
	assert.equal(run.dependencies.filter(d => d.id === 'attempt').length, 1);
	assert.equal(run.dependencies.find(d => d.id === 'attempt').nextRetryAt, new Date(now + cfg.continuation.initialSeconds * 2000).toISOString());
	assert.equal(consumeRetry(run), true); assert.equal(run.dependencies.some(d => d.id === 'attempt'), false);
	const journal = renderAttempts(run);
	assert.match(journal, /Attempt 2 · reviewing · blocked/); assert.match(journal, /Wrong/); assert.match(journal, /Process stalled/); assert.match(journal, /npm test/);
	const briefing = attemptBriefing(run);
	assert.match(briefing, /^## Previous attempts on this task/); assert.match(briefing, /failed 2 times/); assert.match(briefing, /not instructions/);
	assert.ok(briefing.indexOf('Attempt 2') < briefing.indexOf('Attempt 1'), 'newest attempt first');
});

test('identical consecutive failures fold into one journal entry', async t => {
	const {cfg, run} = await blankRun(t);
	for (let index = 0; index < 5; index++) recordAttempt(run, cfg, {phase: 'running', status: 'waiting', kind: 'transport', reason: 'API 529 overloaded', schedule: false});
	assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0].repeats, 4); assert.equal(run.attempts[0].disposition, 'waiting');
	assert.equal(countedFailures(run), 0, 'dependency waits do not count toward the attempt cap');
	assert.match(renderAttempts(run), /repeated 5×/);
});

test('the journal and prompt briefing stay bounded across days of retries', async t => {
	const {cfg, run} = await blankRun(t);
	for (let index = 0; index < 200; index++) recordAttempt(run, cfg, {phase: 'running', status: 'failed', kind: 'code', reason: `failure ${index} ${'x'.repeat(5000)}`, logTail: Array.from({length: 100}, (_, line) => `line ${line} ${'y'.repeat(1000)}`)});
	assert.equal(run.attempts.length, 200);
	assert.equal(run.attempts.filter(attempt => attempt.logTail).length, 10);
	assert.ok(run.attempts.every(attempt => attempt.reason.length <= 2001));
	assert.ok(attemptBriefing(run).length < 13_000);
	assert.match(attemptBriefing(run), /195 older attempts recorded in attempts\.md/);
	assert.equal(run.dependencies.find(d => d.id === 'attempt').attempts, 200);
	assert.ok(Date.parse(run.dependencies.find(d => d.id === 'attempt').nextRetryAt) - Date.now() <= cfg.continuation.maxSeconds * 1000 + 1000);
});

test('maxTaskAttempts stops the loop, and an explicit resume grants a fresh budget', async t => {
	const {cfg, run} = await blankRun(t);
	cfg.recovery.maxTaskAttempts = 2;
	assert.equal(recordAttempt(run, cfg, {phase: 'running', status: 'failed', kind: 'code', reason: 'first'}).disposition, 'retry');
	assert.equal(recordAttempt(run, cfg, {phase: 'running', status: 'failed', kind: 'code', reason: 'second'}).disposition, 'stopped');
	assert.equal(run.state, 'blocked'); assert.match(run.reason, /Stopped after 2 failed attempts/); assert.equal(run.dependencies.some(d => d.id === 'attempt'), false);
	assert.equal(resumableBlocked(run), false);
	assert.deepEqual(schedulingOrder([run], Date.now(), false), []);
	assert.equal(schedulingOrder([run], Date.now(), true).length, 1, 'iteris resume may continue a stopped task');
	assert.equal(recordAttempt(run, cfg, {phase: 'running', status: 'failed', kind: 'code', reason: 'after resume'}).disposition, 'retry');
	const disabled = (await blankRun(t)).run;
	cfg.recovery.enabled = false;
	assert.equal(recordAttempt(disabled, cfg, {phase: 'running', status: 'failed', kind: 'code', reason: 'no recovery'}).disposition, 'stopped');
});

test('tasks blocked by earlier versions rejoin the loop without an explicit resume', async t => {
	const {cwd, cfg, run} = await blankRun(t);
	run.state = 'blocked'; run.reason = 'CI repair budget exhausted'; await saveRun(cwd, run);
	assert.equal(resumableBlocked(run), true);
	assert.equal(schedulingOrder([run], Date.now(), false).length, 1);
	assert.equal((await unfinishedTickets(cwd, cfg)).length, 1);
});

test('the harness kills an instance that stops producing output', async t => {
	const cwd = await temporary(t); await executable(cwd, 'codex', fakeAgent); environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_MODE: 'hang'});
	const cfg = config('codex'); cfg.recovery.idleTimeout = 0.3;
	const started = Date.now();
	const result = await runHarness({config: cfg, phase: 'implementation', prompt: 'You are an autonomous engineer', cwd, timeoutMs: 60_000});
	assert.equal(result.success, false); assert.equal(result.timedOut, true); assert.match(result.error, /stalled: no output/);
	assert.ok(Date.now() - started < 10_000);
});

test('a failed attempt is journaled without prompting and a fresh instance retries with the failure history', async t => {
	const {cwd} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: '1', FAKE_MODE: 'fail', REVIEW_SCENARIO: undefined, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex'); cfg.planMode = false; cfg.recovery.attempts = 0; await atomicWriteConfig(cfg, cwd);
	const failed = [], api = services();
	await runAllTickets([ticket(1)], cfg, cwd, {...quiet, onAttemptFailed: (_, state) => {failed.push(state);}}, undefined, api);
	let run = await readRun(cwd, taskKey(ticket(1), cfg));
	assert.equal(run.state, 'waiting', run.reason); assert.ok(run.dependencies.some(d => d.id === 'attempt'));
	assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0].phase, 'running'); assert.match(run.attempts[0].reason, /Process exited with 2/);
	assert.equal(failed.length, 1); assert.equal(failed[0].status, 'retrying'); assert.equal(failed[0].attempt.number, 1);
	assert.match(await readFile(path.join(cwd, '.iteris/tasks', run.key, 'attempts.md'), 'utf8'), /Attempt 1 · running/);
	delete process.env.FAKE_MODE;
	await runWorker({cwd, config: cfg, once: true, force: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	run = await readRun(cwd, run.key);
	assert.equal(run.state, 'complete', run.reason); assert.equal(api.created.length, 1);
	const implementations = (await calls(cwd)).filter(call => call.prompt.startsWith('You are an autonomous'));
	assert.equal(implementations.length, 2);
	assert.doesNotMatch(implementations[0].prompt, /Previous attempts on this task/);
	assert.match(implementations[1].prompt, /Previous attempts on this task/); assert.match(implementations[1].prompt, /Process exited with 2/);
});

test('an instance that needs a person stops the task until the person answers', async t => {
	const {cwd, cfg, run} = await blankRun(t);
	const record = recordAttempt(run, cfg, {phase: 'running', status: 'needs-person', kind: 'capability', reason: 'Needs two phones.', needsPerson: true});
	assert.equal(record.disposition, 'stopped'); assert.equal(run.state, 'blocked'); assert.equal(run.reason, 'Needs you: Needs two phones.');
	assert.equal(run.dependencies.some(d => d.id === 'attempt'), false);
	assert.equal(awaitingPerson(run), true);
	assert.deepEqual(schedulingOrder([run], Date.now(), false), []);
	assert.deepEqual(schedulingOrder([run], Date.now(), true), [], 'resuming without an answer would meet the same wall');
	assert.match(renderAttempts(run), /Stopped until a person answers/);
	assert.equal(await takeAnswer(cwd, run), false);
	await assert.rejects(submitAnswer(cwd, run.key, '   '), /empty/);
	await submitAnswer(cwd, run.key, 'Use the two simulators.'); await submitAnswer(cwd, run.key, 'Skip Android 12.');
	assert.equal(await answerWaiting(cwd, run.key), true);
	assert.equal(await takeAnswer(cwd, run), true); assert.equal(await answerWaiting(cwd, run.key), false);
	assert.deepEqual(run.answers.map(({question, text}) => ({question, text})), [{question: 'Needs two phones.', text: 'Use the two simulators.\nSkip Android 12.'}]);
	assert.equal(run.state, 'waiting'); assert.equal(schedulingOrder([run], Date.now(), false).length, 1);
	const briefing = attemptBriefing(run);
	assert.match(briefing, /^## Answers from the person responsible for this task/); assert.match(briefing, /Asked: Needs two phones\.\nAnswer: Use the two simulators\.\nSkip Android 12\./);
	assert.match(briefing, /## Previous attempts on this task/); assert.match(renderAttempts(run), /## Answers from a person/);
});

test('the blocked signal ends the attempt loop without a retry or a repair instance', async t => {
	const {cwd} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: undefined, FAKE_MODE: undefined, FAKE_BLOCKED: '1', REVIEW_SCENARIO: undefined, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex'); cfg.planMode = false; await atomicWriteConfig(cfg, cwd);
	const seen = [], api = services();
	await runAllTickets([ticket(1)], cfg, cwd, {...quiet, onStatusChange: (_, state) => {seen.push(state);}}, undefined, api);
	let run = await readRun(cwd, taskKey(ticket(1), cfg));
	assert.equal(run.state, 'blocked', run.reason);
	assert.match(run.reason, /^Needs you: The ticket needs 14 days of production logs/); assert.doesNotMatch(run.reason, /<task>/);
	assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0].disposition, 'stopped'); assert.equal(run.attempts[0].status, 'needs-person');
	assert.equal(seen.at(-1).status, 'blocked'); assert.match(seen.at(-1).failureReason, /^Needs you: /);
	assert.equal((await calls(cwd)).length, 1, 'no repair instance and no second attempt');
	assert.match((await calls(cwd))[0].prompt, /print exactly <task>blocked<\/task>/);
	assert.equal((await unfinishedTickets(cwd, cfg)).length, 0);
	// Neither a watching queue nor iteris resume starts another instance: only an answer does.
	await runWorker({cwd, config: cfg, once: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	await runWorker({cwd, config: cfg, once: true, force: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	assert.equal((await calls(cwd)).length, 1);
	delete process.env.FAKE_BLOCKED; process.env.FAKE_IMPLEMENT = '1';
	await submitAnswer(cwd, run.key, 'The export is in docs/logs.csv.');
	assert.equal((await unfinishedTickets(cwd, cfg)).length, 1, 'an answered task is work again');
	await runWorker({cwd, config: cfg, once: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	run = await readRun(cwd, run.key);
	assert.equal(run.state, 'complete', run.reason);
	const second = (await calls(cwd)).filter(call => call.prompt.startsWith('You are an autonomous'))[1];
	assert.match(second.prompt, /## Answers from the person responsible for this task[\s\S]*Asked: The ticket needs 14 days of production logs[\s\S]*Answer: The export is in docs\/logs\.csv\./);
});

test('a live queue keeps watching a task that asked and continues it as soon as the answer arrives', async t => {
	const {cwd} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: undefined, FAKE_MODE: undefined, FAKE_BLOCKED: '1', REVIEW_SCENARIO: undefined, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex'); cfg.planMode = false; await atomicWriteConfig(cfg, cwd);
	const api = services(), key = taskKey(ticket(1), cfg);
	await runAllTickets([ticket(1)], cfg, cwd, quiet, undefined, api);
	assert.equal((await readRun(cwd, key)).state, 'blocked');
	// Without a person at the screen the queue has nothing left to do; with one it waits for the answer.
	await runWorker({cwd, config: cfg, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	let finished = false;
	const queue = runWorker({cwd, config: cfg, services: api, answers: true, callbacks: quiet, adapter: () => ({refresh: async task => task})}).then(() => {finished = true;});
	await new Promise(resolve => setTimeout(resolve, 1500));
	assert.equal(finished, false);
	delete process.env.FAKE_BLOCKED; process.env.FAKE_IMPLEMENT = '1';
	const answered = Date.now();
	await submitAnswer(cwd, key, 'Use the export in docs/logs.csv.');
	await queue;
	assert.equal((await readRun(cwd, key)).state, 'complete');
	assert.ok(Date.now() - answered < 30_000);
});

test('a repair instance that needs a person stops the task instead of scheduling another repair', async t => {
	const {cwd} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: '1', FAKE_FEATURE: 'broken', FAKE_MODE: undefined, FAKE_BLOCKED: undefined, REVIEW_SCENARIO: undefined, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex'); cfg.planMode = false; cfg.recovery.attempts = 0; await atomicWriteConfig(cfg, cwd);
	const api = services();
	await runAllTickets([ticket(1)], cfg, cwd, quiet, undefined, api);
	let run = await readRun(cwd, taskKey(ticket(1), cfg));
	assert.equal(run.state, 'waiting', run.reason); assert.equal(run.attempts.at(-1).needsRepair, true);
	process.env.FAKE_BLOCKED = 'recover';
	await runWorker({cwd, config: cfg, once: true, force: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	run = await readRun(cwd, run.key);
	assert.equal(run.state, 'blocked', run.reason); assert.match(run.reason, /^Needs you: The ticket needs 14 days/);
	assert.equal(run.attempts.at(-1).disposition, 'stopped'); assert.equal(run.attempts.at(-1).phase, 'repair');
	assert.equal((await unfinishedTickets(cwd, cfg)).length, 0);
	// The answer goes to a repair instance for the same commit, not to a second review of it.
	delete process.env.FAKE_BLOCKED; process.env.REVIEW_SCENARIO = 'recover-ticket-failure';
	await submitAnswer(cwd, run.key, 'Remove the broken branch of the feature.');
	await runWorker({cwd, config: cfg, once: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	run = await readRun(cwd, run.key);
	assert.equal(run.state, 'complete', run.reason);
	const repairs = (await calls(cwd)).filter(call => call.prompt.startsWith('ITERIS_FAILURE_RECOVER'));
	assert.equal(repairs.length, 2); assert.match(repairs[1].prompt, /Answer: Remove the broken branch of the feature\./);
});

test('a blocked review keeps its draft and a fresh repair instance fixes the reviewed commit', async t => {
	const {cwd} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: '1', FAKE_FEATURE: 'broken', FAKE_MODE: undefined, REVIEW_SCENARIO: undefined, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex'); cfg.planMode = false; cfg.recovery.attempts = 0; await atomicWriteConfig(cfg, cwd);
	const api = services();
	await runAllTickets([ticket(1)], cfg, cwd, quiet, undefined, api);
	let run = await readRun(cwd, taskKey(ticket(1), cfg));
	assert.equal(api.created.length, 1, 'the unfinished work is published as a draft');
	assert.equal(run.state, 'waiting', run.reason); assert.equal(run.attempts.at(-1).needsRepair, true);
	assert.ok(run.attempts.at(-1).details.some(detail => /Broken behavior/.test(detail)));
	const blockedHead = run.implementation.head;
	process.env.REVIEW_SCENARIO = 'recover-ticket-failure';
	await runWorker({cwd, config: cfg, once: true, force: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	run = await readRun(cwd, run.key);
	assert.equal(run.state, 'complete', run.reason); assert.notEqual(run.publication.head, blockedHead); assert.equal(api.prs.size, 1);
	const repair = (await calls(cwd)).filter(call => call.prompt.startsWith('ITERIS_FAILURE_RECOVER'));
	assert.equal(repair.length, 1); assert.match(repair[0].prompt, /Broken behavior/); assert.match(repair[0].prompt, /Previous attempts on this task/);
	assert.match(repair[0].prompt, /Evidence stays out of the repository\./);
	const implementation = (await calls(cwd)).find(call => call.prompt.startsWith('You are an autonomous'));
	assert.match(implementation.prompt, /Evidence stays out of the repository\. Put reproduction output[^\n]* in `\.iteris\/evidence\/[\w.-]+\/`/); assert.doesNotMatch(implementation.prompt, /record the exact command|record behavioral commands and output\./);
	assert.match(implementation.prompt, /## Scope\nKeep the change as small as the ticket allows\.[\s\S]*Create a new test file only when no existing one covers that unit\./); assert.match(repair[0].prompt, /Fix what is listed with the smallest change, and nothing else\./);
});

test('partial work left by a crashed instance becomes a checkpoint for the next instance', async t => {
	const {cwd, git} = await reviewRepository(t); await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: '1', FAKE_DIRTY: '1', FAKE_MODE: 'fail', REVIEW_SCENARIO: undefined});
	const cfg = config('codex'); cfg.planMode = false; cfg.recovery.attempts = 0; await atomicWriteConfig(cfg, cwd);
	const api = services();
	await runAllTickets([ticket(1)], cfg, cwd, quiet, undefined, api);
	assert.match(git('status', '--porcelain'), /feature\.txt/, 'the crashed instance left uncommitted work');
	delete process.env.FAKE_DIRTY; delete process.env.FAKE_MODE;
	await runWorker({cwd, config: cfg, once: true, force: true, services: api, callbacks: quiet, adapter: () => ({refresh: async task => task})});
	const run = await readRun(cwd, taskKey(ticket(1), cfg));
	assert.equal(run.state, 'complete', run.reason);
	assert.match(git('log', '--format=%s', run.branch), /Checkpoint partial work/);
	assert.equal(execFileSync('git', ['show', `${run.branch}:feature.txt`], {cwd, encoding: 'utf8'}).trim(), `implemented ${run.branch}`);
});

test('running out of task time after verification schedules a fresh check instead of blocking', async t => {
	const {cfg, run, cwd} = await blankRun(t);
	run.requirements = extractRequirements(run.ticket, cfg); run.publication = {url: 'https://example.com/pr', number: 1, head: 'head', base: 'base', draft: true};
	for (const requirement of run.requirements.filter(r => ['local', 'review', 'publication'].includes(r.stage))) addEvidence(run, requirement.id, 'head', 'fixture', 'verified', true, 'base');
	await saveRun(cwd, run);
	await advanceCompletion({...cfg, _deadline: Date.now() - 1}, run, cwd, completionServices);
	assert.equal(run.state, 'waiting'); assert.ok(run.dependencies.some(d => d.id === 'deadline'));
	await advanceCompletion(cfg, run, cwd, completionServices);
	assert.equal(run.state, 'complete', run.reason);
});
