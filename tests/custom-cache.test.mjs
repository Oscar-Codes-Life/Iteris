import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, unlink, symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {loadCustomTasks, readSavedCustomTasks} from '../dist/custom/cache.js';
import {customStatuses, importCustom} from '../dist/custom/import.js';
import {createRunFolder, writeStatus} from '../dist/state/manager.js';
import {temporary, environment, config} from './helpers.mjs';
const cfg = () => ({...config(), provider: 'custom', custom: {endpoint: 'https://example.com/tasks', apiKeyEnv: 'CACHE_TEST_KEY', itemsPath: ''}});
const offline = {fetcher: async () => assert.fail('must not fetch'), harness: async () => assert.fail('must not convert')};
async function fixture(t) {
 const cwd = await temporary(t);
 execFileSync('git', ['init', '-q', cwd]);
 environment(t, {CACHE_TEST_KEY: 'fake-cache-key'});
 let fetches = 0, conversions = 0;
 const services = {
  fetcher: async () => {fetches++; return Response.json([{id: 1, title: 'Original'}]);},
  harness: async () => {conversions++; return {success: true, done: false, timedOut: false, text: JSON.stringify({title: 'Converted', description: 'Task body', attachments: []})};},
 };
 return {cwd, services, counts: () => [fetches, conversions]};
}
test('restart reuses valid downloaded tasks without a key, HTTP, or harness call', async t => {
 const f = await fixture(t);
 const first = await loadCustomTasks(cfg(), f.cwd, f.services);
 assert.equal(first.cached, false);
 delete process.env.CACHE_TEST_KEY;
 const second = await loadCustomTasks(cfg(), f.cwd, offline);
 assert.equal(second.cached, true);
 assert.equal(second.directory, first.directory);
 assert.deepEqual(second.tickets, first.tickets);
 assert.deepEqual(f.counts(), [1, 1]);
 const task = second.tickets[0];
 const folder = await createRunFolder(f.cwd, task);
 await writeStatus(folder, {ticket: task, status: 'done', branch: 'branch', logLines: [], elapsedMs: 0});
 assert.equal((await customStatuses(f.cwd, second.tickets)).get(task.number), 'done');
});
test('explicit refresh fetches again; failed refresh preserves the existing cache', async t => {
 const f = await fixture(t);
 await loadCustomTasks(cfg(), f.cwd, f.services);
 const refreshed = await loadCustomTasks(cfg(), f.cwd, {...f.services, refresh: true});
 assert.deepEqual(f.counts(), [2, 2]);
 await assert.rejects(loadCustomTasks(cfg(), f.cwd, {refresh: true, fetcher: async () => {throw new Error('offline');}}), /Download failed/);
 assert.equal((await loadCustomTasks(cfg(), f.cwd, offline)).directory, refreshed.directory);
});
test('a different endpoint or mapping cannot reuse tasks from another source', async t => {
 const f = await fixture(t);
 await loadCustomTasks(cfg(), f.cwd, f.services);
 for (const update of [{endpoint: 'https://example.com/other'}, {idPath: 'ticket.id'}, {apiKeyEnv: 'OTHER_CACHE_KEY'}]) {
  process.env.OTHER_CACHE_KEY = 'fake-cache-key';
  const result = await loadCustomTasks({...cfg(), custom: {...cfg().custom, ...update}}, f.cwd, f.services);
  assert.equal(result.cached, false);
 }
 assert.deepEqual(f.counts(), [4, 4]);
});
test('missing task files fail clearly instead of silently fetching again', async t => {
 const f = await fixture(t);
 const first = await loadCustomTasks(cfg(), f.cwd, f.services);
 await unlink(first.tickets[0].custom.taskFile);
 await assert.rejects(loadCustomTasks(cfg(), f.cwd, offline), /iteris refresh/);
});
test('legacy downloads require one confirmation, then reuse automatically', async t => {
 const f = await fixture(t);
 const first = await importCustom(cfg(), f.cwd, f.services);
 const file = path.join(first.directory, 'manifest.json');
 const manifest = JSON.parse(await readFile(file, 'utf8'));
 delete manifest.sourceKey;
 await writeFile(file, JSON.stringify(manifest));
 let confirmed = 0;
 const loaded = await loadCustomTasks(cfg(), f.cwd, {...offline, useLegacy: async (dir, count) => {
  confirmed++; assert.equal(dir, first.directory); assert.equal(count, 1); return true;
 }});
 assert.equal(loaded.cached, true);
 await loadCustomTasks(cfg(), f.cwd, {...offline, useLegacy: async () => assert.fail('already confirmed')});
 assert.equal(confirmed, 1);
});
test('completed source-tagged imports can be recovered if the cache index is missing', async t => {
 const f = await fixture(t);
 const first = await importCustom(cfg(), f.cwd, f.services);
 assert.equal((await loadCustomTasks(cfg(), f.cwd, offline)).directory, first.directory);
});
test('empty refresh replaces an older nonempty cache and remains usable offline', async t => {
 const f = await fixture(t);
 await loadCustomTasks(cfg(), f.cwd, f.services);
 const empty = await loadCustomTasks(cfg(), f.cwd, {refresh: true, fetcher: async () => Response.json([])});
 assert.equal(empty.tickets.length, 0);
 assert.deepEqual((await loadCustomTasks(cfg(), f.cwd, offline)).tickets, []);
});
test('saved attachments are validated and cannot point outside the download directory', async t => {
 const f = await fixture(t);
 const first = await loadCustomTasks(cfg(), f.cwd, f.services);
 const file = path.join(first.directory, 'manifest.json');
 const manifest = JSON.parse(await readFile(file, 'utf8'));
 const outside = path.join(f.cwd, 'outside.txt');
 await writeFile(outside, 'not a downloaded attachment');
 await symlink(outside, path.join(first.directory, 'attachments', 'escape.txt'));
 manifest.tasks[0].attachments = [{name: 'unsafe', file: 'attachments/escape.txt'}];
 await writeFile(file, JSON.stringify(manifest));
 await assert.rejects(readSavedCustomTasks(first.directory), /Invalid saved task file/);
});
