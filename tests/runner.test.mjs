import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteConfig,updateConfig,loadConfig} from '../dist/config.js';
import {generatePrDescription} from '../dist/agent/pr-description.js';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {captureContext} from '../dist/review/context.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {loadPendingQueue} from '../dist/state/queue.js';
import {temporary,environment,executable,config,fakeAgent,reviewRepository} from './helpers.mjs';
const ticket=number=>({number,title:`Ticket ${number}`,body:'Implement feature',slug:`ticket-${number}`,labels:[],htmlUrl:'https://example.com/ticket'});
function services() {
 const prs=new Map(),created=[];
 return {created,findPr:async(_config,branch)=>prs.get(branch),createPr:async(_config,input)=>{created.push(input);const pr={url:'https://example.com/pr',number:5};prs.set(input.branch,pr);return pr;},addLabel:async()=>{},moveCard:async()=>{}};
}
test('PR description harness receives the final diff and appends the ticket reference',async t=>{
 const cwd=await temporary(t);execFileSync('git',['init','-q','-b','main',cwd]);execFileSync('git',['config','user.email','test@example.com'],{cwd});execFileSync('git',['config','user.name','Test'],{cwd});
 await writeFile(path.join(cwd,'feature.txt'),'before\n');execFileSync('git',['add','feature.txt'],{cwd});execFileSync('git',['commit','-qm','base'],{cwd});execFileSync('git',['checkout','-qb','iteris/1-ticket-1'],{cwd});
 await writeFile(path.join(cwd,'feature.txt'),'after\n');execFileSync('git',['add','feature.txt'],{cwd});execFileSync('git',['commit','-qm','change feature'],{cwd});
 await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,CAPTURE:path.join(cwd,'calls.jsonl')});
 const result=await generatePrDescription({ticket:ticket(1),config:config('codex'),cwd,review:'npm test passed'});assert.equal(result.success,true);assert.match(result.text,/Closes #1$/);
 const call=JSON.parse((await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim());assert.match(call.prompt,/change feature/);assert.match(call.prompt,/\+after/);assert.match(call.prompt,/npm test passed/);
});
for(const harness of ['claude','codex']) test(`${harness} full ticket lifecycle smoke test`,async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config(harness);await atomicWriteConfig(cfg,cwd);const statuses=[],api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange:(_,s)=>statuses.push(s.status),onLogLine(){},onComplete(){},onFailure:async()=>{assert.fail('Unexpected failure');return 'skip';}},undefined,api);
 for(const phase of ['planning','running','reviewing','creating-pr','summarizing','done']) assert.ok(statuses.includes(phase),phase);
 const folder=path.join(cwd,'.iteris/runs/1-ticket-1');assert.match(await readFile(path.join(folder,'plan.md'),'utf8'),/Implementation plan/);assert.match(await readFile(path.join(folder,'summary.md'),'utf8'),/Session summary/);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,7);assert.ok(calls.every(call=>call.harness===harness));
 assert.equal(api.created.length,1);assert.equal(api.created[0].title,'Ticket 1');assert.match(api.created[0].body,/## Summary/);assert.match(api.created[0].body,/Closes #1$/);
 const descriptionCall=calls.find(call=>call.prompt.startsWith('Write a high-value pull request description'));assert.ok(descriptionCall);assert.ok(!descriptionCall.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('successive missing test evidence self-heals and reaches PR creation',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'progressive-evidence',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');cfg.review.maxRepairCycles=2;await atomicWriteConfig(cfg,cwd);
 const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 const report=JSON.parse(await readFile(path.join(cwd,'.iteris/runs/1-ticket-1/review/result.json'),'utf8'));
 assert.equal(report.outcome,'passed');assert.equal(report.repairs,3);
 assert.deepEqual(report.checks.map(check=>check.command),['true','printf recovery-one','printf recovery-two','printf recovery-three']);
});
test('unavailable hosted gate opens a PR with incomplete evidence and continues the queue',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-legacy'});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[],doneStates=new Map();
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(number,state){if(state.status==='done')doneStates.set(number,state);},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);
 assert.deepEqual(completed,[1,2]);
 assert.match(doneStates.get(1).reviewPending,/SUPABASE_ACCESS_TOKEN/);
 for(const pr of api.created){assert.match(pr.body,/INCOMPLETE/);assert.match(pr.body,/SUPABASE_ACCESS_TOKEN/);}
 const report=JSON.parse(await readFile(path.join(cwd,'.iteris/runs/1-ticket-1/review/result.json'),'utf8'));
 assert.equal(report.outcome,'incomplete');assert.equal(report.deferredToCI,true);
});
test('CI recovery blocker cannot stop PR creation when reviewer also returned a candidate',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-with-candidate'});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[1,2]);
 assert.match(api.created[0].body,/INCOMPLETE/);
 assert.match(api.created[0].body,/SUPABASE_ACCESS_TOKEN/);
});
test('any incomplete review opens a PR and advances the queue without a CI classifier',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'incomplete'});
 const cfg=config('codex');cfg.planMode=false;cfg.review.maxRepairCycles=0;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[1,2]);
 assert.match(api.created[0].body,/INCOMPLETE/);
});
test('CI-only gaps continue to the next ticket when repair cycles are disabled',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-direct'});
 const cfg=config('codex');cfg.planMode=false;cfg.review.maxRepairCycles=0;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[1,2]);
 assert.match(api.created[0].body,/CI schema-contract gate requires SUPABASE_ACCESS_TOKEN/);
});
test('a malformed verifier response is corrected and ticket reaches PR creation',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'verifier-extra-findings',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(call=>call.prompt.startsWith('ITERIS_REVIEW verify')).length,1);
 assert.equal(calls.filter(call=>call.prompt.startsWith('ITERIS_SCHEMA_RECOVER')).length,1);
});
test('a persistent schema mismatch opens an incomplete PR without ticket retries',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'malformed',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);const api=services();let recoveries=0;
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,state){if(state.status==='recovering')recoveries++;},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);assert.equal(recoveries,0);assert.match(api.created[0].body,/INCOMPLETE/);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.some(call=>call.prompt.startsWith('ITERIS_FAILURE_RECOVER')),false);
 assert.equal(calls.some(call=>call.prompt.startsWith('Write a high-value pull request description')),false);
});
test('a failed implementation launches a repair agent and continues to a PR',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:'fail',REVIEW_SCENARIO:'recover-ticket-failure',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,state){if(state.status==='recovering')delete process.env.FAKE_MODE;},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(call=>call.prompt.startsWith('ITERIS_FAILURE_RECOVER')).length,1);
 assert.equal(calls.filter(call=>call.prompt.startsWith('You are an autonomous')).length,1);
});
test('an interrupted queue resumes review without repeating implementation',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const controller=new AbortController();let aborted=false;
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(_,line){if(!aborted&&line.includes('[review] Round 1')){aborted=true;controller.abort();}},onComplete(){},onFailure:async()=>assert.fail('cancelled queue should stop')},controller.signal,services());
 assert.equal(aborted,true);
 const pending=await loadPendingQueue(cwd,cfg);assert.equal(pending.length,1);
 const saved=JSON.parse(await readFile(path.join(cwd,'.iteris/runs/1-ticket-1/review/result.json'),'utf8'));
 assert.equal(saved.stamp.scope,captureContext(pending[0],cfg,cwd,'').stamp.scope);
 const api=services();
 await runAllTickets(pending,cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 assert.equal(await loadPendingQueue(cwd,cfg),undefined);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(call=>call.prompt.startsWith('You are an autonomous')).length,1);
});
test('a crash before review context resumes the committed implementation and saved plan',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);
 const controller=new AbortController();let aborted=false;
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,state){if(!aborted&&state.status==='reviewing'){aborted=true;controller.abort();}},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('cancelled queue should stop')},controller.signal,services());
 assert.equal(aborted,true);
 const pending=await loadPendingQueue(cwd,cfg);assert.equal(pending.length,1);
 const api=services();
 await runAllTickets(pending,cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(call=>call.prompt.startsWith('Inspect this task')).length,1);
 assert.equal(calls.filter(call=>call.prompt.startsWith('You are an autonomous')).length,1);
});
test('an existing branch PR is reused without generating a replacement description',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',CAPTURE:path.join(cwd,'calls.jsonl')});const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('unexpected failure')},undefined,{findPr:async()=>({url:'https://example.com/existing',number:3}),createPr:async()=>assert.fail('must not create a duplicate PR'),addLabel:async()=>{},moveCard:async()=>{}});
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(call=>call.prompt.startsWith('Write a high-value pull request description')),false);
});
test('changes apply at next ticket; retry retains original harness',async t=>{
 const {cwd}=await reviewRepository(t);for(const h of ['claude','codex'])await executable(cwd,h,fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:'fail',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('claude');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);let changed=false;
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},beforeTicket:()=>loadConfig(cwd),onFailure:async()=>{
  assert.equal(changed,false);changed=true;process.env.FAKE_MODE='normal';await updateConfig(c=>{c.harness='codex';},cwd);return 'retry';
 }},undefined,services());
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(call=>call.harness),[...Array(8).fill('claude'),...Array(6).fill('codex')]);
 assert.equal(calls.filter(call=>call.prompt.startsWith('ITERIS_FAILURE_RECOVER')).length,1);
});
test('Trello completion uses same pipeline without GitHub issue labeling',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined});
 const cfg=config('codex');cfg.provider='trello';cfg.planMode=false;cfg.pr.addLabelOnOpen='review';await atomicWriteConfig(cfg,cwd);let moved=0;const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('unexpected failure')},undefined,{...api,addLabel:async()=>assert.fail('must not label a GitHub issue using a Trello number'),moveCard:async()=>{moved++;}});
 assert.equal(moved,1);assert.match(api.created[0].body,/Implements Trello card: https:\/\/example.com\/ticket$/);
});

test('review process failure opens an incomplete PR without repeating implementation or planning',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,s){if(s.status==='reviewing')process.env.FAKE_MODE='fail';},onLogLine(){},onComplete(){},onFailure:async(_,s)=>assert.fail(s.failureReason)},undefined,api);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(api.created.length,1);assert.match(api.created[0].body,/INCOMPLETE/);assert.match(api.created[0].body,/Process exited with 2/);
 assert.equal(calls.filter(c=>c.prompt.startsWith('ITERIS_FAILURE_RECOVER')).length,0);
 assert.equal(calls.filter(c=>c.prompt.startsWith('Inspect this task')).length,1);
 assert.equal(calls.filter(c=>c.prompt.startsWith('You are an autonomous')).length,1);
});

test('review obeys configured timeout and exposes timeout result',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:'hang'});
 execFileSync('git',['checkout','-qb','iteris/1-ticket-1'],{cwd});
 await writeFile(path.join(cwd,'feature.txt'),'changed\n');execFileSync('git',['add','feature.txt'],{cwd});execFileSync('git',['commit','-qm','change'],{cwd});
 const cfg=config('codex');cfg.timeout=0.2;
 const result=await runCodeReview({ticket:ticket(1),config:cfg,cwd,folder:path.join(cwd,'.iteris/review-timeout'),onLogLine(){},onProcess(){}});
 assert.equal(result.success,false);assert.equal(result.timedOut,true,result.error);assert.match(result.error,/timed out|deadline/i);
});
