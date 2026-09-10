import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {saveTrelloCredentials} from '../dist/trello/auth.js';
import {temporary, environment} from './helpers.mjs';

const credentials = {apiKey: 'test-key', token: 'test-token'};
for (const shell of ['bash', 'zsh']) {
 for (const existing of [false, true]) {
  test(`${shell} saves credentials to its own profile (${existing ? 'existing' : 'new'} profiles)`, async t => {
   const home = await temporary(t);
   environment(t, {SHELL: `/bin/${shell}`});
   if (existing) {
    await writeFile(path.join(home, '.bashrc'), '# Bash settings\n');
    await writeFile(path.join(home, '.zshrc'), '# Zsh settings\n');
   }
   saveTrelloCredentials(credentials, {home, zdotdir: ''});
   const content = await readFile(path.join(home, `.${shell}rc`), 'utf8');
   assert.match(content, /export TRELLO_API_KEY='test-key'/);
   assert.match(content, /export TRELLO_TOKEN='test-token'/);
   if (existing) {
    assert.match(content, /^# (Bash|Zsh) settings\n/);
    const other = shell === 'bash' ? 'zsh' : 'bash';
    assert.equal(await readFile(path.join(home, `.${other}rc`), 'utf8'), other === 'bash' ? '# Bash settings\n' : '# Zsh settings\n');
   } else {
    assert.deepEqual(await readdir(home), [`.${shell}rc`]);
   }
   assert.equal(process.env.TRELLO_TOKEN, credentials.token);
  });
 }
}

test('Zsh respects ZDOTDIR and Bash ignores it', async t => {
 const home = await temporary(t);
 const zdotdir = path.join(home, 'zsh');
 await mkdir(zdotdir);
 environment(t, {});
 saveTrelloCredentials(credentials, {home, shell: '/bin/zsh', zdotdir});
 assert.match(await readFile(path.join(zdotdir, '.zshrc'), 'utf8'), /test-key/);
 saveTrelloCredentials(credentials, {home, shell: '/bin/bash', zdotdir});
 assert.match(await readFile(path.join(home, '.bashrc'), 'utf8'), /test-key/);
});

test('saved credentials survive shell expansion and quoting unchanged', async t => {
 const home = await temporary(t);
 environment(t, {});
 const special = {apiKey: "key'with\"quotes", token: '$(printf expanded)`printf expanded`$USER\\token'};
 const profile = saveTrelloCredentials(special, {home, shell: '/bin/bash'});
 const result = execFileSync('bash', ['--noprofile', '--norc', '-c', '. "$1"; printf "%s\\n%s" "$TRELLO_API_KEY" "$TRELLO_TOKEN"', 'test', profile], {encoding: 'utf8'});
 assert.equal(result, `${special.apiKey}\n${special.token}`);
});

test('unsupported shells do not write a guessed profile or change credentials', async t => {
 const home = await temporary(t);
 environment(t, {TRELLO_TOKEN: 'original'});
 assert.throws(() => saveTrelloCredentials(credentials, {home, shell: '/bin/fish'}), /Unsupported shell/);
 assert.deepEqual(await readdir(home), []);
 assert.equal(process.env.TRELLO_TOKEN, 'original');
});
