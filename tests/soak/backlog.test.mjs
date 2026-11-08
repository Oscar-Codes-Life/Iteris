import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteConfig} from '../../dist/config.js';
import {runAllTickets} from '../../dist/agent/runner.js';
import {runWorker} from '../../dist/lifecycle/worker.js';
import {listRuns} from '../../dist/lifecycle/state.js';
import {environment, executable, config, fakeAgent, reviewRepository} from '../helpers.mjs';

// A backlog run end to end with deterministic chaos: crashed, stalled and
// rate-limited instances, crashes that leave uncommitted work, implementations
// that review blocks, recovery instances that crash, and failed hosted CI. No
// person answers anything. The queue must drain to zero with every ticket
// verified complete, and fresh instances must receive the failure history.
const size = 20;
const ticket = number => ({number, title: `Ticket ${number}`, body: 'Implement feature', slug: `ticket-${number}`, labels: [], htmlUrl: `https://example.com/ticket/${number}`});

test(`a chaotic backlog of ${size} tickets drains to zero without human input`, {timeout: 420_000}, async t => {
	const started = Date.now();
	const {cwd} = await reviewRepository(t);
	const chaos = path.join(cwd, '.iteris', 'chaos');
	await mkdir(chaos, {recursive: true});
	await executable(cwd, 'codex', fakeAgent);
	environment(t, {PATH: `${cwd}:${process.env.PATH}`, FAKE_IMPLEMENT: '1', FAKE_MODE: undefined, REVIEW_SCENARIO: undefined, CHAOS_DIR: chaos, CAPTURE: path.join(cwd, 'calls.jsonl')});
	const cfg = config('codex');
	cfg.planMode = false;
	cfg.workspace = {mode: 'worktree', concurrency: 3};
	cfg.recovery.idleTimeout = 2;
	cfg.continuation.initialSeconds = 0.05;
	cfg.continuation.maxSeconds = 0.2;
	await atomicWriteConfig(cfg, cwd);

	const prs = new Map(), failedCi = new Map(), statuses = new Map();
	let ciFailures = 0;
	const api = {
		findPr: async (_config, branch) => prs.get(branch),
		createPr: async (_config, input) => {const pr = {url: `https://example.com/pr/${prs.size + 1}`, number: prs.size + 1}; prs.set(input.branch, pr); return pr;},
		addLabel: async () => {}, moveCard: async () => {}, draft: async () => {}, updateReview: async () => {}, status: async () => {},
		// Every seventh ticket fails hosted CI on its first published commit.
		ci: async (_config, run) => {
			const number = run.ticket.number, head = run.publication.head;
			if (number % 7 === 0 && (!failedCi.has(number) || failedCi.get(number) === head)) {
				if (!failedCi.has(number)) ciFailures++;
				failedCi.set(number, head);
				return {state: 'failed', details: 'unit: expected fixed, received broken', head, base: run.publication.base};
			}
			return {state: 'passed', details: 'required checks passed', head, base: run.publication.base};
		},
	};
	const callbacks = {
		onStatusChange(number, state) {statuses.set(number, [...(statuses.get(number) ?? []), state.status]);},
		onLogLine() {}, onComplete() {},
		onAttemptFailed() {},
	};
	const backlog = Array.from({length: size}, (_, index) => ticket(index + 1));
	const deadline = new AbortController();
	const guard = setTimeout(() => deadline.abort(), 360_000);
	try {
		await runAllTickets(backlog, cfg, cwd, callbacks, deadline.signal, api);
		const afterFirstPass = (await listRuns(cwd, cfg.repo)).filter(run => run.state !== 'complete').length;
		t.diagnostic(`after the first pass: ${afterFirstPass} of ${size} tickets still unfinished`);
		assert.ok(afterFirstPass > 0, 'chaos must leave work for the attempt loop');
		await runWorker({cwd, config: cfg, services: api, callbacks, signal: deadline.signal, adapter: () => ({refresh: async task => task})});
	} finally {clearTimeout(guard);}
	assert.equal(deadline.signal.aborted, false, 'the backlog did not drain before the safety deadline');

	const runs = await listRuns(cwd, cfg.repo);
	assert.equal(runs.length, size);
	for (const run of runs) assert.equal(run.state, 'complete', `#${run.ticket.number}: ${run.reason}`);
	assert.equal(prs.size, size, 'one PR per ticket, never duplicated by retries');

	const events = (await readFile(path.join(chaos, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
	const injected = events.filter(event => !['none', 'repair'].includes(event.fault));
	const byFault = Object.fromEntries(['crash', 'stall', 'dirty', 'broken', 'ratelimit'].map(fault => [fault, injected.filter(event => event.fault === fault).length]));
	for (const [fault, count] of Object.entries(byFault)) assert.ok(count > 0, `no ${fault} fault was exercised`);
	assert.ok(ciFailures > 0);

	// Every ticket whose instance crashed, stalled or was rate limited has a journal.
	// A broken implementation may instead be repaired inside the same review.
	const journaled = runs.filter(run => run.attempts?.length);
	for (const number of new Set(injected.filter(event => event.fault !== 'broken' || event.phase === 'recover').map(event => event.number))) {
		const run = runs.find(candidate => candidate.ticket.number === number);
		assert.ok(run.attempts?.length, `#${number} failed without a journal entry`);
		assert.match(await readFile(path.join(cwd, '.iteris/tasks', run.key, 'attempts.md'), 'utf8'), /Attempt 1 · /);
	}
	const calls = (await readFile(path.join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
	const informed = calls.filter(call => /^(You are an autonomous|ITERIS_FAILURE_RECOVER)/.test(call.prompt) && call.prompt.includes('## Previous attempts on this task'));
	assert.ok(informed.length > 0, 'fresh instances must receive the attempt journal');
	assert.ok(runs.every(run => !(statuses.get(run.ticket.number) ?? []).includes('blocked')), 'no ticket was abandoned');

	const attempts = runs.reduce((sum, run) => sum + (run.attempts ?? []).reduce((total, attempt) => total + 1 + (attempt.repeats ?? 0), 0), 0);
	t.diagnostic(`backlog: ${size} tickets, ${size} complete, ${prs.size} PRs`);
	t.diagnostic(`injected faults: ${JSON.stringify(byFault)}, failed CI runs: ${ciFailures}, recovery crashes: ${events.filter(event => event.phase === 'recover' && event.fault === 'crash').length}`);
	t.diagnostic(`journaled attempts: ${attempts} across ${journaled.length} tickets; harness instances: ${calls.length}; instances given the journal: ${informed.length}`);
	t.diagnostic(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
});
