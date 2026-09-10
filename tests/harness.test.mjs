import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {atomicWriteConfig, loadConfig} from '../dist/config.js';
import {runHarness, invocation, decodeEvent} from '../dist/harness/process.js';
import {listModels, claudeModels} from '../dist/harness/models.js';
import {setHarness,setModel,setEffort} from '../dist/harness/settings.js';
import {temporary,environment,executable,config,fakeAgent} from './helpers.mjs';

test('discovers paginated models and restores per-harness settings',async t=>{
 const cwd=await temporary(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:cwd});
 assert.deepEqual((await listModels('codex')).map(m=>m.id),['test-model','second-model']);
 await atomicWriteConfig(config(),cwd); await setHarness('codex',cwd); await setEffort('low',cwd); await setModel('second-model',cwd); await setHarness('claude',cwd);
 assert.equal((await loadConfig(cwd)).harnesses.claude.effort,'xhigh');
 const restored=await setHarness('codex',cwd);assert.equal(restored.harnesses.codex.model,'second-model');assert.equal(restored.harnesses.codex.effort,'low');
 await assert.rejects(setEffort('ultra',cwd)); await assert.rejects(setModel('unknown',cwd));
});
test('Claude model change resets unsupported effort and removes effort on Haiku',async t=>{
 const cwd=await temporary(t);await atomicWriteConfig(config(),cwd);
 const sonnet=await setModel('sonnet',cwd);assert.equal(sonnet.harnesses.claude.effort,'high');
 const haiku=await setModel('haiku',cwd);assert.equal(haiku.harnesses.claude.effort,undefined);
 assert.deepEqual(claudeModels.find(m=>m.id==='opus').efforts,['low','medium','high','xhigh','max']);
});
for(const harness of ['claude','codex']) {
 test(`${harness} arguments restrict planning, PR descriptions, and summaries while preserving explicit model/effort`,()=>{
  const cfg=config(harness);
  const planned=invocation(cfg,'planning'),described=invocation(cfg,'pr-description'),run=invocation(cfg,'implementation');
  assert.ok(!planned.args.includes('--dangerously-skip-permissions'));assert.ok(!planned.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!described.args.includes('--dangerously-skip-permissions'));assert.ok(!described.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  if(harness==='claude')assert.equal(described.args[described.args.indexOf('--tools')+1],'');else assert.ok(described.args.includes('read-only'));
  assert.ok(run.args.includes(cfg.harnesses[harness].model));assert.ok(planned.args.includes(harness==='claude'?'plan':'read-only'));
 });
 for(const mode of ['normal','fail','tool','malformed','hang']) test(`${harness}: ${mode} process output`,async t=>{
  const cwd=await temporary(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:cwd,FAKE_MODE:mode});
  const result=await runHarness({config:config(harness),phase:'implementation',prompt:'Implement',cwd,timeoutMs:mode==='hang'?150:2000});
  assert.equal(result.success,mode==='normal'||mode==='tool'); assert.equal(result.done,mode==='normal'||mode==='fail');assert.equal(result.timedOut,mode==='hang');
 });
 test(`${harness}: spawn failure and cancellation settle`,async t=>{
  const cwd=await temporary(t);environment(t,{PATH:cwd});
  const failed=await runHarness({config:config(harness),phase:'implementation',prompt:'x',cwd,timeoutMs:2000});assert.equal(failed.success,false);
  await executable(cwd,harness,fakeAgent);process.env.FAKE_MODE='hang';const controller=new AbortController();
  const pending=runHarness({config:config(harness),phase:'implementation',prompt:'x',cwd,timeoutMs:2000,signal:controller.signal});setTimeout(()=>controller.abort(),50);
  assert.equal((await pending).error,'Cancelled');
 });
}
test('structured failure events and tool output cannot masquerade as success',()=>{
 assert.ok(decodeEvent('codex',JSON.stringify({type:'turn.failed',error:{message:'failed'}})).failed);
 assert.ok(decodeEvent('claude',JSON.stringify({type:'result',is_error:true,result:'failed'})).failed);
 assert.equal(decodeEvent('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'<task>done</task>'}})).assistant,undefined);
});
test('model discovery errors settle and do not return a guessed catalog',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd});
 await executable(cwd,'codex',`process.stdout.write('not json\n');`);
 await assert.rejects(listModels('codex'));
});
