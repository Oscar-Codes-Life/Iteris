import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteConfig,updateConfig,loadConfig} from '../dist/config.js';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {temporary,environment,executable,config,fakeAgent} from './helpers.mjs';
const ticket=number=>({number,title:`Ticket ${number}`,body:'Implement feature',slug:`ticket-${number}`,labels:[],htmlUrl:'https://example.com/ticket'});
const services={findPr:async()=>({url:'https://example.com/pr',number:5}),addLabel:async()=>{},moveCard:async()=>{}};
for(const harness of ['claude','codex']) test(`${harness} full ticket lifecycle smoke test`,async t=>{
 const cwd=await temporary(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:cwd,FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config(harness);await atomicWriteConfig(cfg,cwd);const statuses=[];
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange:(_,s)=>statuses.push(s.status),onLogLine(){},onComplete(){},onFailure:async()=>{assert.fail('Unexpected failure');return 'skip';}},undefined,services);
 for(const phase of ['planning','running','reviewing','summarizing','done']) assert.ok(statuses.includes(phase),phase);
 const folder=path.join(cwd,'.iteris/runs/1-ticket-1');assert.match(await readFile(path.join(folder,'plan.md'),'utf8'),/Implementation plan/);assert.match(await readFile(path.join(folder,'summary.md'),'utf8'),/Session summary/);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,4);assert.ok(calls.every(call=>call.harness===harness));
});
test('changes apply at next ticket; retry retains original harness',async t=>{
 const cwd=await temporary(t);for(const h of ['claude','codex'])await executable(cwd,h,fakeAgent);
 environment(t,{PATH:cwd,FAKE_MODE:'fail',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('claude');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);let changed=false;
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},beforeTicket:()=>loadConfig(cwd),onFailure:async()=>{
  assert.equal(changed,false);changed=true;process.env.FAKE_MODE='normal';await updateConfig(c=>{c.harness='codex';},cwd);return 'retry';
 }},undefined,services);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(call=>call.harness),['claude','claude','claude','claude','codex','codex','codex']);
});
test('Trello completion uses same pipeline without GitHub issue labeling',async t=>{
 const cwd=await temporary(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:cwd,FAKE_MODE:undefined});
 const cfg=config('codex');cfg.provider='trello';cfg.planMode=false;cfg.pr.addLabelOnOpen='review';await atomicWriteConfig(cfg,cwd);let moved=0;
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('unexpected failure')},undefined,{...services,addLabel:async()=>assert.fail('must not label a GitHub issue using a Trello number'),moveCard:async()=>{moved++;}});
 assert.equal(moved,1);
});

test('review failure preserves cause and retries review without repeating implementation or planning',async t=>{
 const cwd=await temporary(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:cwd,FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);let reviews=0,failures=0;
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,s){if(s.status==='reviewing')process.env.FAKE_MODE=++reviews===1?'fail':undefined;},onLogLine(){},onComplete(){},onFailure:async(_,s)=>{
  failures++;assert.match(s.failureReason,/review.*Process exited with 2/i);return 'retry';
 }},undefined,services);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(failures,1);assert.equal(calls.length,5);
 assert.equal(calls.filter(c=>c.prompt.startsWith('Inspect this task')).length,1);
 assert.equal(calls.filter(c=>c.prompt.startsWith('You are an autonomous')).length,1);
});

test('review obeys configured timeout and exposes timeout result',async t=>{
 const cwd=await temporary(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:cwd,FAKE_MODE:'hang'});
 const cfg=config('codex');cfg.timeout=0.05;
 const result=await runCodeReview({ticket:ticket(1),config:cfg,cwd,folder:cwd,onLogLine(){},onProcess(){}});
 assert.equal(result.success,false);assert.equal(result.timedOut,true);assert.equal(result.error,'Process timed out');
});
