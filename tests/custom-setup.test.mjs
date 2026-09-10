import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {atomicWriteConfig, loadConfig} from '../dist/config.js';
import {temporary, config} from './helpers.mjs';

test('custom setup stays alive after the Ink provider picker and saves typed answers', {timeout: 10000}, async t => {
 const cwd = await temporary(t);
 await atomicWriteConfig({...config(), provider: 'custom'}, cwd);
 const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import React from 'react';
  import {render} from 'ink';
  import {ProviderPicker} from './dist/ui/ProviderPicker.js';
  import {setupCustom} from './dist/custom/setup.js';
  import {loadConfig} from './dist/config.js';
  // Keep a real OS input handle, so Ink's unref() can cause premature exit.
  // Only terminal capabilities are stubbed; ref/unref and input are real.
  process.stdin.isTTY = true;
  process.stdin.setRawMode = () => {};
  const provider = await new Promise(resolve => {
   const view = render(React.createElement(ProviderPicker, {
    onSelect(value) {view.unmount(); resolve(value);}
   }));
  });
  if (provider !== 'custom') throw new Error('Wrong provider selected');
  await setupCustom(await loadConfig(process.argv[1]), process.argv[1]);
 `, cwd], {cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe']});
 t.after(() => {if (child.exitCode === null) child.kill();});
 const exited = once(child, 'exit');
 let output = '';
 child.stdout.on('data', chunk => {output += chunk;});
 child.stderr.on('data', chunk => {output += chunk;});
 async function waitFor(text) {
  for (let i = 0; i < 300; i++) {
   if (output.includes(text)) return;
   assert.equal(child.exitCode, null, `Exited before ${text}: ${output}`);
   await delay(10);
  }
  assert.fail(`Missing ${text}: ${output}`);
 }
 await waitFor('Select a ticket source');
 child.stdin.write('j');
 await waitFor('> Trello');
 child.stdin.write('j');
 await waitFor('> Custom REST endpoint');
 child.stdin.write('\r');
 await waitFor('REST endpoint URL');
 await delay(200);
 assert.equal(child.exitCode, null, `Exited while waiting for endpoint input: ${output}`);
 child.stdin.write('https://api.example.com/tasks\n');
 await waitFor('API key environment variable name');
 child.stdin.write('CUSTOM_TEST_KEY\n');
 await waitFor('Items path');
 child.stdin.write('data.tasks\n');
 await waitFor('ID path');
 child.stdin.write('ticket.id\n');
 assert.deepEqual(await exited, [0, null], output);
 assert.deepEqual((await loadConfig(cwd)).custom, {
  endpoint: 'https://api.example.com/tasks', apiKeyEnv: 'CUSTOM_TEST_KEY',
  itemsPath: 'data.tasks', idPath: 'ticket.id',
 });
});
