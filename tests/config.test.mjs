import {execFileSync} from 'node:child_process';
import {detectDefaultBranch, validateBaseBranch} from '../dist/github/repo.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, readFile, mkdir, readdir} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig, atomicWriteConfig, updateConfig, configSchema} from '../dist/config.js';
import {temporary, config} from './helpers.mjs';

test('migrates legacy settings, preserves unknown fields and backup, and is idempotent', async t => {
 const cwd=await temporary(t), file=path.join(cwd,'.iteris.json');
 // custom is now a reserved provider configuration key; use an unrelated extension.
 const old=JSON.stringify({repo:'org/repo',claudeFlags:['--dangerously-skip-permissions'],timeout:12,extensionData:{x:1},trello:{boardId:'abc',extension:true}});
 await writeFile(file,old);
 const migrated=await loadConfig(cwd);
 assert.equal(migrated.version,2); assert.equal(migrated.harness,'claude'); assert.equal(migrated.setupComplete,false);
 assert.equal(migrated.harnesses.claude.model,undefined); assert.deepEqual(migrated.extensionData,{x:1}); assert.equal(migrated.trello.extension,true);
 assert.equal('claudeFlags' in migrated,false); assert.equal(await readFile(file+'.v1.bak','utf8'),old);
 const first=await readFile(file,'utf8'); await loadConfig(cwd); assert.equal(await readFile(file,'utf8'),first);
 await updateConfig(c=>{c.timeout=20;},cwd); assert.equal(await readFile(file+'.v1.bak','utf8'),old);
});
for(const raw of ['{','[]',JSON.stringify({repo:'org/repo',version:99}),JSON.stringify({repo:'org/repo',timeout:-1})]) test(`rejects invalid config without overwriting: ${raw}`, async t=>{
 const cwd=await temporary(t), file=path.join(cwd,'.iteris.json');await writeFile(file,raw);
 await assert.rejects(loadConfig(cwd));assert.equal(await readFile(file,'utf8'),raw);assert.deepEqual(await readdir(cwd),['.iteris.json']);
});
test('atomic write failure cleans temporary files and leaves destination intact',async t=>{
 const cwd=await temporary(t);await mkdir(path.join(cwd,'.iteris.json'));
 await assert.rejects(atomicWriteConfig(config(),cwd));assert.deepEqual(await readdir(cwd),['.iteris.json']);
});
test('parallel field updates preserve both changes',async t=>{
 const cwd=await temporary(t);await atomicWriteConfig(config(),cwd);
 await Promise.all([updateConfig(c=>{c.timeout=44;},cwd),updateConfig(c=>{c.baseBranch='develop';},cwd)]);
 const result=await loadConfig(cwd);assert.equal(result.timeout,44);assert.equal(result.baseBranch,'develop');
});
test('managed flags reject hidden overrides',()=>{
 for(const flag of ['--model=foo','-mfoo','--effort','-c','--output-format','--permission-mode','--sandbox']) {
  const value=config();value.harnesses.claude.flags=[flag]; assert.equal(configSchema.safeParse(value).success,false,flag);
 }
});

test('detects master default and rejects a missing configured base before work',async t=>{
 const cwd=await temporary(t);
 const git=(...args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
 git('init','-b','master');
 git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','initial');
 git('update-ref','refs/remotes/origin/master','HEAD');
 git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/master');
 assert.equal(detectDefaultBranch(cwd),'master');
 await writeFile(path.join(cwd,'.iteris.json'),JSON.stringify({version:2,repo:'org/repo'}));
 assert.equal((await loadConfig(cwd)).baseBranch,'master');
 assert.throws(()=>validateBaseBranch('main',cwd),/Set baseBranch to "master"/);
 validateBaseBranch('master',cwd);
 git('update-ref','refs/remotes/origin/develop','HEAD');
 validateBaseBranch('develop',cwd);
});

test('default phase timeout is two hours; explicit settings are preserved',()=>{
 assert.equal(configSchema.parse({version:2,repo:'org/repo'}).timeout,7200);
 assert.equal(configSchema.parse({version:2,repo:'org/repo',timeout:3600}).timeout,3600);
});
