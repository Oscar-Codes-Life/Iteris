// Regression fixtures for the September 24–25 Roxbase failures. No real model calls or provider writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {captureContext} from '../dist/review/context.js';
import {reviewRepository, environment, executable, fakeAgent, config} from './helpers.mjs';

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

test('regression: mixed recovery executes local commands and independently reviews the final commit', async t => {
  const f = await fixture(t, 'recover-with-blocker', 'broken\n', externalBlocker);
  environment(t, {AUDIT_EXTERNAL_BLOCKER: '1'});
  const before = f.git('rev-parse', 'HEAD');
  const result = await runCodeReview(f.options);
  const after = f.git('rev-parse', 'HEAD');
  assert.notEqual(after, before);
  assert.equal(result.report.outcome, 'passed', result.error);
  assert.equal(result.report.dependencies[0].description, 'Physical-device evidence is pending');
  assert.equal(result.report.stamp.head, after);
  assert.equal(result.report.checks.some(check => check.command === 'printf recovery-evidence' && check.head === after), true);
});

test('regression: recovered dependency at unchanged HEAD receives fresh evaluation', async t => {
  const f = await fixture(t, 'recover-evidence', 'changed\n', externalBlocker);
  // Required evidence is a dependency whose resolution needs a fresh evaluation, never a reused pass.
  f.cfg.workflow.externalEvidence = 'required';
  environment(t, {AUDIT_EXTERNAL_BLOCKER: '1'});
  const first = await runCodeReview(f.options);
  assert.equal(first.report.dependencies[0].description,'Physical-device evidence is pending');
  delete process.env.AUDIT_EXTERNAL_BLOCKER;
  const context = captureContext(ticket, f.cfg, f.cwd);
  const firstHead = context.stamp.head;
  const directRetry = await runCodeReview(f.options);
  assert.equal(directRetry.report.outcome, 'passed', directRetry.error);
  assert.equal(directRetry.report.stamp.head,firstHead);assert.equal(directRetry.report.dependencies?.length??0,0);
});

test('regression: mixed-severity duplicates preserve the strongest blocker and reach repair', async t => {
  const f = await fixture(t, 'duplicate-status', 'changed\n', value => {
    assert.ok(value.includes("priority:scenario==='advisory'?'medium':'high'"), 'Fixture contract changed');
    return value.replace("priority:scenario==='advisory'?'medium':'high'", "priority:'medium'")
      .replace('const duplicateFinding={...finding,title:', "const duplicateFinding={...finding,priority:'high',title:");
  });
  const result = await runCodeReview(f.options);
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.report.repairs, 2);
  assert.equal(result.report.findings.find(f=>!f.duplicateOf && f.status==='confirmed').priority,'high');
  const calls = (await readFile(path.join(f.cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(call => call.prompt.startsWith('ITERIS_REPAIR')), true);
});
