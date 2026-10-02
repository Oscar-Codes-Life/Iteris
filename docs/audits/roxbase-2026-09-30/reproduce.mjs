// Diagnostic fixtures for the September 24–25 Roxbase run. No real model calls.
// Run from repository root after npm run build:
// node --test docs/audits/roxbase-2026-09-30/reproduce.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runCodeReview} from '../../../dist/agent/reviewer.js';
import {captureContext} from '../../../dist/review/context.js';
import {loadUnfinishedReview} from '../../../dist/review/report.js';
import {reviewRepository, environment, executable, fakeAgent, config} from '../../../tests/helpers.mjs';

const ticket = {number: 1, title: 'Feature', body: 'Implement feature and verify it. Device verification follows.', slug: 'feature', labels: [], htmlUrl: 'https://example.com/1'};

async function fixture(t, scenario, content = 'changed\n', transform = value => value) {
  const repo = await reviewRepository(t);
  repo.git('checkout', '-qb', 'iteris/1-feature');
  await writeFile(path.join(repo.cwd, 'feature.txt'), content);
  repo.git('add', 'feature.txt');
  repo.git('commit', '-qm', 'change');
  await executable(repo.cwd, 'codex', transform(fakeAgent));
  environment(t, {PATH: `${repo.cwd}:${process.env.PATH}`, FAKE_MODE: 'normal', FAKE_IMPLEMENT: undefined, REVIEW_SCENARIO: scenario, CAPTURE: path.join(repo.cwd, 'calls.jsonl')});
  const cfg = config('codex');
  cfg.review.maxRepairCycles = 2;
  return {...repo, cfg, options: {ticket, config: cfg, cwd: repo.cwd, folder: path.join(repo.cwd, '.iteris/runs/1-feature'), onLogLine() {}, onProcess() {}}};
}

const externalBlocker = value => {
  const needle = 'blockedReason:legacyCI?';
  assert.ok(value.includes(needle), 'Fixture contract changed');
  return value.replace(needle, "blockedReason:process.env.AUDIT_EXTERNAL_BLOCKER?'Physical-device evidence is pending':legacyCI?");
};

test('reproduces: recovery commits a fix but an external blocker discards local commands and final-head review', async t => {
  const f = await fixture(t, 'recover-with-blocker', 'broken\n', externalBlocker);
  environment(t, {AUDIT_EXTERNAL_BLOCKER: '1'});
  const before = f.git('rev-parse', 'HEAD');
  const result = await runCodeReview(f.options);
  const after = f.git('rev-parse', 'HEAD');
  assert.notEqual(after, before);
  assert.equal(result.report.outcome, 'incomplete');
  assert.match(result.error, /Physical-device evidence/);
  assert.equal(result.report.stamp.head, before);
  assert.equal(result.report.checks.some(check => check.command === 'printf recovery-evidence'), false);
  console.log(JSON.stringify({case: 'mixed-local-and-external-gap', newCommit: true, reportStillAtOldCommit: true, returnedLocalCommandExecuted: false, outcome: result.report.outcome}));
});

test('reproduces: unfinished publication cache is reused after the external blocker disappears', async t => {
  const f = await fixture(t, 'recover-evidence', 'changed\n', externalBlocker);
  environment(t, {AUDIT_EXTERNAL_BLOCKER: '1'});
  const first = await runCodeReview(f.options);
  assert.equal(first.report.outcome, 'incomplete');
  delete process.env.AUDIT_EXTERNAL_BLOCKER;
  const context = captureContext(ticket, f.cfg, f.cwd);
  const cached = await loadUnfinishedReview(path.join(f.options.folder, 'review'), context);
  assert.equal(cached.report.outcome, 'incomplete');
  const directRetry = await runCodeReview(f.options);
  assert.equal(directRetry.report.outcome, 'passed', directRetry.error);
  console.log(JSON.stringify({case: 'unfinished-review-cache', runnerWouldReuseIncomplete: true, directReviewRetryAfterDependencyRecovery: directRetry.report.outcome}));
});

test('reproduces: duplicate findings with mixed severity terminate review before repair', async t => {
  const f = await fixture(t, 'duplicate-status', 'changed\n', value => {
    assert.ok(value.includes("priority:scenario==='advisory'?'medium':'high'"), 'Fixture contract changed');
    return value.replace("priority:scenario==='advisory'?'medium':'high'", "priority:'medium'")
      .replace('const duplicateFinding={...finding,title:', "const duplicateFinding={...finding,priority:'high',title:");
  });
  const result = await runCodeReview(f.options);
  assert.equal(result.report.outcome, 'incomplete');
  assert.match(result.error, /Deduplication cannot downgrade a blocking finding/);
  assert.equal(result.report.repairs, 0);
  const calls = (await readFile(path.join(f.cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(call => call.prompt.startsWith('ITERIS_REPAIR')), false);
  console.log(JSON.stringify({case: 'mixed-severity-duplicate', outcome: result.report.outcome, repairReached: false, reason: result.error}));
});
