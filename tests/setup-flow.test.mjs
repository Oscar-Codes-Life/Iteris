import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {atomicWriteConfig, loadConfig} from '../dist/config.js';
import {temporary, executable, config} from './helpers.mjs';

const cli = new URL('../dist/index.js', import.meta.url);

async function fixture(t) {
 const cwd = await temporary(t), tools = await temporary(t);
 execFileSync('git', ['init', '-q', '-b', 'main'], {cwd});
 execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/org/repo.git'], {cwd});
 await executable(tools, 'claude', `
  if (process.argv.slice(2).join(' ') !== 'auth status') process.exitCode = 1;
 `);
 await executable(tools, 'codex', `
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('--json --model --sandbox');
  else if (args.join(' ') === 'login status') process.exitCode = 0;
  else if (args.join(' ') === 'app-server') {
   require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'initialize' ? {} : {data: [
     {model: 'test-model', displayName: 'Test model', supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'high'}], defaultReasoningEffort: 'high', isDefault: true},
    ], nextCursor: null};
    console.log(JSON.stringify({id: request.id, result}));
   });
  } else process.exitCode = 1;
 `);
 await executable(tools, 'gh', `
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(path.join(tools, 'github-calls.jsonl'))}, JSON.stringify(args) + '\\n');
  if (args.join(' ') === 'auth token --hostname github.com') console.log('fixture-token');
  else if (args.join(' ') !== 'api user --silent') process.exitCode = 1;
 `);
 // Use only fixture credentials and binaries; no real login or API calls.
 // CI=false: under CI=true (GitHub Actions) Ink renders only the final frame, hiding interactive prompts.
 const env = {...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, GH_TOKEN: '', GITHUB_TOKEN: '', NO_COLOR: '1', FORCE_COLOR: '0', CI: 'false'};
 return {cwd, tools, env};
}

function terminal(t, {cwd, env}, command) {
 const child = spawn(process.execPath, ['--input-type=module', '-e', `
  // Keep the real OS stdin handle, including Ink's ref/unref behavior.
  process.stdin.isTTY = true;
  process.stdin.setRawMode = value => {process.stdin.isRaw = value;};
  process.stdout.columns = 120;
  process.stdout.rows = 40;
  process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, ...process.argv.slice(1)];
  await import(${JSON.stringify(cli.href)});
 `, command], {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
 t.after(() => {if (child.exitCode === null) child.kill();});
 const exited = once(child, 'exit');
 let output = '';
 const capture = chunk => {output += stripVTControlCharacters(chunk.toString());};
 child.stdout.on('data', capture);
 child.stderr.on('data', capture);
 async function waitFor(text, after = 0) {
  for (let attempt = 0; attempt < 500; attempt++) {
   if (output.slice(after).includes(text)) return;
   assert.equal(child.exitCode, null, `Exited before ${text}: ${output}`);
   await delay(10);
  }
  assert.fail(`Missing ${text}: ${output}`);
 }
 async function pick(title, nextLabels = [], key = '\u001b[B') {
  await waitFor(title);
  await delay(20);
  for (const label of nextLabels) {
   const after = output.length;
   child.stdin.write(key);
   await waitFor(`> ${label}`, after);
  }
  child.stdin.write('\r');
 }
 return {child, exited, waitFor, pick, output: () => output};
}

for (const harness of ['claude', 'codex']) test(`fresh ${harness} CLI setup saves worktree settings and opens the Instances monitor`, {timeout: 20000}, async t => {
 const project = await fixture(t);
 await assert.rejects(readFile(path.join(project.cwd, '.iteris.json')), {code: 'ENOENT'});
 const ui = terminal(t, project, 'setup');
 await ui.pick('Which harness?', harness === 'codex' ? ['Codex'] : []);
 await ui.pick('Which model?', harness === 'claude' ? ['Sonnet 4.6'] : []);
 await ui.pick('Which effort level?', harness === 'claude' ? ['max'] : []);
 await ui.pick('Default workspace?', ['Worktree · isolated branches, parallel tasks'], '\u001b[A');
 await ui.pick('Maximum parallel tasks?', ['4 tasks']);
 await ui.waitFor('Select a ticket source');
 ui.child.stdin.write('\r');
 assert.deepEqual(await ui.exited, [0, null], ui.output());
 const saved = await loadConfig(project.cwd);
 assert.equal(saved.setupComplete, true);
 assert.equal(saved.repo, 'org/repo');
 assert.equal(saved.provider, 'github');
 assert.equal(saved.harness, harness);
 assert.equal(saved.harnesses[harness].model, harness === 'claude' ? 'sonnet' : 'test-model');
 assert.equal(saved.harnesses[harness].effort, harness === 'claude' ? 'max' : 'high');
 assert.deepEqual(saved.workspace, {mode: 'worktree', concurrency: 4});
 assert.match(ui.output(), /Setup complete/);
 const calls = (await readFile(path.join(project.tools, 'github-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls, [['auth', 'token', '--hostname', 'github.com'], ['api', 'user', '--silent']]);

 const monitor = terminal(t, project, 'instances');
 await monitor.waitFor('Worktrees · up to 4 parallel tasks');
 await monitor.waitFor('No instances yet');
 monitor.child.stdin.write('q');
 assert.deepEqual(await monitor.exited, [0, null], monitor.output());
});

test('rerunning CLI setup revisits worktree options and continues through custom endpoint questions', {timeout: 20000}, async t => {
 const project = await fixture(t);
 const previous = config('codex');
 previous.provider = 'github';
 previous.workspace = {mode: 'local', concurrency: 1};
 await atomicWriteConfig(previous, project.cwd);
 const ui = terminal(t, project, 'setup');
 await ui.waitFor('Which harness?');
 ui.child.stdin.write('\u001b[A');
 await ui.waitFor('> Claude Code');
 ui.child.stdin.write('\r');
 await ui.pick('Which model?');
 await ui.pick('Which effort level?');
 await ui.pick('Default workspace?', ['Worktree · isolated branches, parallel tasks'], '\u001b[A');
 await ui.pick('Maximum parallel tasks?', ['2 tasks']);
 await ui.pick('Select a ticket source', ['Trello', 'Custom REST endpoint']);
 await ui.waitFor('REST endpoint URL');
 await delay(100);
 assert.equal(ui.child.exitCode, null, ui.output());
 ui.child.stdin.write('https://api.example.com/tasks\n');
 await ui.waitFor('API key environment variable name');
 ui.child.stdin.write('CUSTOM_TEST_KEY\n');
 await ui.waitFor('Items path');
 ui.child.stdin.write('data.tasks\n');
 await ui.waitFor('ID path');
 ui.child.stdin.write('ticket.id\n');
 assert.deepEqual(await ui.exited, [0, null], ui.output());
 const saved = await loadConfig(project.cwd);
 assert.equal(saved.setupComplete, true);
 assert.equal(saved.harness, 'claude');
 assert.equal(saved.harnesses.claude.model, 'opus');
 assert.equal(saved.harnesses.claude.effort, 'xhigh');
 assert.deepEqual(saved.workspace, {mode: 'worktree', concurrency: 2});
 assert.equal(saved.provider, 'custom');
 assert.deepEqual(saved.custom, {endpoint: 'https://api.example.com/tasks', apiKeyEnv: 'CUSTOM_TEST_KEY', itemsPath: 'data.tasks', idPath: 'ticket.id'});
 assert.deepEqual(saved.qualityChecks, previous.qualityChecks);
});
