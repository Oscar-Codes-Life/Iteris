import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {atomicWriteConfig,loadConfig} from '../dist/config.js';
import {setupHarness,configure,prepareHarness} from '../dist/setup.js';
import {resetReadiness} from '../dist/harness/readiness.js';
import {temporary,environment,executable,config} from './helpers.mjs';

test('first setup follows harness/model/effort order and saves selections',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd});await executable(cwd,'claude','process.exitCode=0');resetReadiness();
 const cfg=config();cfg.setupComplete=false;await atomicWriteConfig(cfg,cwd);const questions=[];
 const result=await setupHarness(cwd,async(title,options)=>{questions.push(title);return title==='Which harness?'?'claude':title==='Which model?'?'sonnet':'medium';});
 assert.deepEqual(questions,['Which harness?','Which model?','Which effort level?']);assert.equal(result.harnesses.claude.model,'sonnet');assert.equal(result.harnesses.claude.effort,'medium');
});
test('returning user needs no picker; direct model command can repair unavailable saved model',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd});await executable(cwd,'claude','process.exitCode=0');resetReadiness();await atomicWriteConfig(config(),cwd);
 const picker=async()=>assert.fail('unnecessary picker');await prepareHarness(await loadConfig(cwd),picker,cwd);
 const invalid=config();invalid.harnesses.claude.model='retired';await atomicWriteConfig(invalid,cwd);
 const fixed=await configure('model','sonnet',{cwd,picker});assert.equal(fixed.harnesses.claude.model,'sonnet');
});
test('live switch to missing Codex persists pending choice without installing',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd});await atomicWriteConfig(config(),cwd);
 await executable(cwd,'sh',`require('node:fs').writeFileSync(${JSON.stringify(path.join(cwd,'unexpected-install'))},'bad')`);
 const pending=await configure('harness','codex',{cwd,active:true});assert.equal(pending.harness,'codex');await assert.rejects(readFile(path.join(cwd,'unexpected-install')));
});
test('invalid CLI input does not overwrite settings',async t=>{
 const cwd=await temporary(t);await atomicWriteConfig(config(),cwd);const original=await readFile(path.join(cwd,'.iteris.json'),'utf8');
 await assert.rejects(configure('harness','wrong',{cwd,active:true}));await assert.rejects(configure('unknown',undefined,{cwd,active:true}));assert.equal(await readFile(path.join(cwd,'.iteris.json'),'utf8'),original);
});
test('external commands defer updates while another queue owns the repository',async t=>{
 const {acquireRun,hasActiveRun}=await import('../dist/state/active.js');
 const cwd=await temporary(t);environment(t,{PATH:cwd});await atomicWriteConfig(config(),cwd);
 const release=await acquireRun(cwd);
 try {
  assert.equal(await hasActiveRun(cwd),true);
  await assert.rejects(acquireRun(cwd),/already running/);
  // With no codex installed this must save the switch, never attempt install.
  const next=await configure('harness','codex',{cwd});assert.equal(next.harness,'codex');
 } finally {await release();}
 assert.equal(await hasActiveRun(cwd),false);
});
test('a dead queue lock is reclaimed once while a live queue remains exclusive',async t=>{
 const {acquireRun,hasActiveRun}=await import('../dist/state/active.js');
 const cwd=await temporary(t);await mkdir(path.join(cwd,'.iteris'));
 const dead=Number(execFileSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).trim());
 await writeFile(path.join(cwd,'.iteris/active.json'),JSON.stringify({pid:dead}));
 assert.equal(await hasActiveRun(cwd),false);
 const attempts=await Promise.allSettled([acquireRun(cwd),acquireRun(cwd)]);
 assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(attempts.filter(result=>result.status==='rejected').length,1);
 assert.equal(await hasActiveRun(cwd),true);
 await attempts.find(result=>result.status==='fulfilled').value();
 assert.equal(await hasActiveRun(cwd),false);
});
