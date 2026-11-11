import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteConfig,updateConfig,loadConfig} from '../dist/config.js';
import {generatePrDescription,prBody,cleanDescription} from '../dist/agent/pr-description.js';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {captureContext} from '../dist/review/context.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {taskKey,readRun} from '../dist/lifecycle/state.js';
import {prepareEnvironment} from '../dist/lifecycle/environment.js';
import {loadPendingQueue} from '../dist/state/queue.js';
import {temporary,environment,executable,config,fakeAgent,reviewRepository} from './helpers.mjs';
const ticket=number=>({number,title:`Ticket ${number}`,body:'Implement feature',slug:`ticket-${number}`,labels:[],htmlUrl:'https://example.com/ticket'});
function services() {
 const prs=new Map(),created=[];
 return {created,ci:async(_cfg,run)=>({state:'passed',details:'fixture required CI passed',head:run.publication.head,base:run.publication.base}),draft:async()=>{},findPr:async(_config,branch)=>prs.get(branch),createPr:async(_config,input)=>{created.push(input);const pr={url:'https://example.com/pr',number:5};prs.set(input.branch,pr);return pr;},addLabel:async()=>{},moveCard:async()=>{}};
}
test('PR description harness receives the final diff and appends the ticket reference',async t=>{
 const cwd=await temporary(t);execFileSync('git',['init','-q','-b','main',cwd]);execFileSync('git',['config','user.email','test@example.com'],{cwd});execFileSync('git',['config','user.name','Test'],{cwd});
 await writeFile(path.join(cwd,'feature.txt'),'before\n');execFileSync('git',['add','feature.txt'],{cwd});execFileSync('git',['commit','-qm','base'],{cwd});execFileSync('git',['checkout','-qb','iteris/1-ticket-1'],{cwd});
 await writeFile(path.join(cwd,'feature.txt'),'after\n');execFileSync('git',['add','feature.txt'],{cwd});execFileSync('git',['commit','-qm','change feature'],{cwd});
 await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,CAPTURE:path.join(cwd,'calls.jsonl')});
 const result=await generatePrDescription({ticket:ticket(1),config:config('codex'),cwd,review:'npm test passed'});assert.equal(result.success,true);assert.match(result.text,/^## Summary/);assert.doesNotMatch(result.text,/Closes #1|iteris:review/);assert.match(prBody(result.text,'review text','Closes #1'),/^<!-- iteris:description:start -->\n## Summary[\s\S]*<!-- iteris:description:end -->\n\n<!-- iteris:review:start -->\nreview text\n<!-- iteris:review:end -->\n\nCloses #1$/);
 const call=JSON.parse((await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim());assert.match(call.prompt,/change feature/);assert.match(call.prompt,/\+after/);assert.match(call.prompt,/npm test passed/);
});
for(const harness of ['claude','codex']) test(`${harness} full ticket lifecycle smoke test`,async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config(harness);await atomicWriteConfig(cfg,cwd);const statuses=[],api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange:(_,s)=>statuses.push(s.status),onLogLine(){},onComplete(){},onFailure:async()=>{assert.fail('Unexpected failure');return 'skip';}},undefined,api);
 for(const phase of ['planning','running','reviewing','creating-pr','summarizing','done']) assert.ok(statuses.includes(phase),phase);
 const folder=path.join(cwd,'.iteris/tasks',taskKey(ticket(1),cfg),'artifacts');assert.match(await readFile(path.join(folder,'plan.md'),'utf8'),/Implementation plan/);assert.match(await readFile(path.join(folder,'summary.md'),'utf8'),/Session summary/);
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
 const report=JSON.parse(await readFile(path.join(cwd,'.iteris/tasks',taskKey(ticket(1),cfg),'artifacts/review/result.json'),'utf8'));
 assert.equal(report.outcome,'incomplete');assert.equal(report.repairs,2);
 assert.deepEqual(report.checks.map(check=>check.command),['true','printf recovery-one','printf recovery-two']);
});
test('unavailable hosted gate opens a PR with incomplete evidence and continues the queue',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-legacy'});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[],doneStates=new Map();
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(number,state){if(state.status==='waiting')doneStates.set(number,state);},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);
 assert.deepEqual(completed,[]);
 assert.match(doneStates.get(1).reviewPending,/SUPABASE_ACCESS_TOKEN/);
 for(const pr of api.created){assert.match(pr.body,/INCOMPLETE/);assert.match(pr.body,/SUPABASE_ACCESS_TOKEN/);}
 const report=JSON.parse(await readFile(path.join(cwd,'.iteris/tasks',taskKey(ticket(1),cfg),'artifacts/review/result.json'),'utf8'));
 assert.equal(report.outcome,'incomplete');assert.equal(report.deferredToCI,true);
});
test('CI recovery blocker cannot stop PR creation when reviewer also returned a candidate',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-with-candidate'});
 const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[]);
 assert.match(api.created[0].body,/INCOMPLETE/);
 assert.match(api.created[0].body,/SUPABASE_ACCESS_TOKEN/);
});
test('any incomplete review opens a PR and advances the queue without a CI classifier',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'incomplete'});
 const cfg=config('codex');cfg.planMode=false;cfg.review.maxRepairCycles=0;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[]);
 assert.match(api.created[0].body,/INCOMPLETE/);
});
test('CI-only gaps continue to the next ticket when repair cycles are disabled',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'external-gap-direct'});
 const cfg=config('codex');cfg.planMode=false;cfg.review.maxRepairCycles=0;await atomicWriteConfig(cfg,cwd);
 const api=services(),completed=[];
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete:number=>completed.push(number),onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,2);assert.deepEqual(completed,[]);
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
 const saved=JSON.parse(await readFile(path.join(cwd,'.iteris/tasks',taskKey(ticket(1),cfg),'artifacts/review/result.json'),'utf8'));
 await prepareEnvironment(cfg,cwd);assert.equal(saved.stamp.scope,captureContext(pending[0],cfg,cwd,'').stamp.scope);
 const api=services();
 await runAllTickets(pending,cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.equal(api.created.length,1);
 assert.equal(await loadPendingQueue(cwd,cfg),undefined);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(call=>call.prompt.startsWith('You are an autonomous')).length,1);
});
test('an unchanged incomplete review opens its PR on resume without spending another review attempt',async t=>{
 const {cwd,remote,git}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',REVIEW_SCENARIO:'incomplete',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');cfg.planMode=false;cfg.review.maxRepairCycles=0;await atomicWriteConfig(cfg,cwd);
 const offline={...services(),createPr:async()=>{throw new Error('PR API temporarily unavailable');}};
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=> 'skip'},undefined,offline);
 const resultPath=path.join(cwd,'.iteris/tasks',taskKey(ticket(1),cfg),'artifacts/review/result.json');
 const previous=JSON.parse(await readFile(resultPath,'utf8'));
 await writeFile(resultPath,JSON.stringify({...previous,reason:'Cancelled',finishedAt:'2999-01-01T00:00:00.000Z'}));
 const before=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const api=services();
 // The base moves on the remote while this attempt is already reviewing; an attempt starts from the base it fetched.
 let moved=false;const head=git('rev-parse','HEAD');
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(_,state){if(state.status==='reviewing'&&!moved){moved=true;execFileSync('git',['--git-dir',remote,'update-ref','refs/heads/main',head]);}},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)},undefined,api);
 assert.ok(moved);
 const after=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(after.filter(call=>call.prompt.startsWith('ITERIS_REVIEW')).length>before.filter(call=>call.prompt.startsWith('ITERIS_REVIEW')).length);
 assert.equal(after.filter(call=>call.prompt.startsWith('You are an autonomous')).length,1);
 assert.equal(api.created.length,1);assert.match(api.created[0].body,/INCOMPLETE/);assert.ok(api.created[0].body.includes('incomplete'));
 assert.match(api.created[0].body,/remote base changed after this review/i);
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
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('unexpected failure')},undefined,{...services(),findPr:async()=>({url:'https://example.com/existing',number:3}),createPr:async()=>assert.fail('must not create a duplicate PR'),addLabel:async()=>{},moveCard:async()=>{}});
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(call=>call.prompt.startsWith('Write a high-value pull request description')),false);
});
test('changes apply at next ticket; immediate repair of a failed attempt retains original harness',async t=>{
 const {cwd}=await reviewRepository(t);for(const h of ['claude','codex'])await executable(cwd,h,fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:'fail',REVIEW_SCENARIO:'recover-ticket-failure',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('claude');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);let changed=false;const api=services();
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{onStatusChange(_,state){if(state.status==='recovering')delete process.env.FAKE_MODE;},onLogLine(){},onComplete(){},beforeTicket:()=>loadConfig(cwd),onAttemptFailed:async(number,state)=>{
  assert.equal(changed,false);assert.equal(number,1);assert.equal(state.attempt.disposition,'retry');changed=true;await updateConfig(c=>{c.harness='codex';},cwd);
 }},undefined,api);
 assert.equal(changed,true);assert.equal(api.created.length,2);
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const firstCodex=calls.findIndex(call=>call.harness==='codex');
 assert.ok(firstCodex>0);assert.ok(calls.slice(0,firstCodex).every(call=>call.harness==='claude'));assert.ok(calls.slice(firstCodex).every(call=>call.harness==='codex'));
 const recovery=calls.filter(call=>call.prompt.startsWith('ITERIS_FAILURE_RECOVER'));
 assert.equal(recovery.length,1);assert.equal(recovery[0].harness,'claude');assert.match(recovery[0].prompt,/Previous attempts on this task/);assert.match(recovery[0].prompt,/Process exited with 2/);
 const run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'complete',run.reason);assert.equal(run.attempts.length,1);
});
test('Trello completion uses same pipeline without GitHub issue labeling',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined});
 const cfg=config('codex');cfg.provider='trello';cfg.planMode=false;cfg.pr.addLabelOnOpen='review';await atomicWriteConfig(cfg,cwd);let moved=0;const api=services();
 await runAllTickets([ticket(1)],cfg,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=>assert.fail('unexpected failure')},undefined,{...api,addLabel:async()=>assert.fail('must not label a GitHub issue using a Trello number'),moveCard:async()=>{moved++;}});
 assert.equal(moved,0);assert.match(api.created[0].body,/Implements Trello card: https:\/\/example.com\/ticket$/);
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
test('oversized trusted context stops before any instance runs and continues once the limit is raised',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);const calls=path.join(cwd,'calls.jsonl');
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,CAPTURE:calls});
 const git=(...args)=>execFileSync('git',args,{cwd});
 git('checkout','-q','main');await writeFile(path.join(cwd,'AGENTS.md'),'Repository policy.\n'.repeat(3600));git('add','AGENTS.md');git('commit','-qm','large engineering guide');git('push','-q','origin','main');
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);const api=services(),states=[];
 const callbacks={onStatusChange:(_,s)=>states.push(s),onLogLine(){},onComplete(){}};
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 await assert.rejects(readFile(calls,'utf8'),{code:'ENOENT'});
 const run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'waiting');assert.match(run.reason,/verification\.maxContextCharacters/);assert.match(run.reason,/total 68,4\d\d/);assert.match(run.reason,/: AGENTS\.md 68,4\d\d\)/,'the oversized file is named');
 assert.equal(states.at(-1).status,'waiting');assert.match(run.dependencies[0].nextAction,/maxContextCharacters/);
 cfg.verification.maxContextCharacters=100000;await atomicWriteConfig(cfg,cwd);
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 assert.equal(api.created.length,1);assert.equal((await readRun(cwd,taskKey(ticket(1),cfg))).state,'complete');
});
test('a task whose remaining evidence needs a device completes with a manual follow-up; required evidence keeps it waiting',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:'external',CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);const api=services(),drafts=[];api.draft=async(_cfg,_number,draft)=>{drafts.push(draft);};
 const callbacks={onStatusChange(){},onLogLine(){},onComplete(){}};
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 const run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'complete',run.reason);assert.equal(run.dependencies.length,0);assert.equal(drafts.at(-1),false);
 const followUp=run.requirements.find(r=>r.id.startsWith('dependency:manual-'));assert.ok(followUp);
 assert.match(await readFile(path.join(cwd,'.iteris/tasks',run.key,'status.md'),'utf8'),/needs manual verification; not verified by Iteris and not blocking/);
 const strict={...cfg,workflow:{...cfg.workflow,externalEvidence:'required'}};await atomicWriteConfig(strict,cwd);
 await runAllTickets([ticket(2)],strict,cwd,callbacks,undefined,api);
 const waiting=await readRun(cwd,taskKey(ticket(2),strict));assert.equal(waiting.state,'waiting');assert.ok(waiting.dependencies.some(d=>d.kind==='external'||d.id.startsWith('stage:manual-')));
});
test('a branch that conflicts with the moved base is merged and resolved by an instance before review',async t=>{
 const {cwd,remote}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);const calls=path.join(cwd,'calls.jsonl');
 const git=(...args)=>execFileSync('git',args,{cwd,stdio:'pipe',encoding:'utf8'}).trim();
 git('checkout','-qb','iteris/1-ticket-1');await writeFile(path.join(cwd,'feature.txt'),'earlier ticket work\n');git('add','feature.txt');git('commit','-qm','earlier attempt');git('checkout','-q','main');
 const other=await temporary(t),theirs=(...args)=>execFileSync('git',args,{cwd:other,stdio:'pipe',encoding:'utf8'}).trim();
 execFileSync('git',['clone','-q',remote,other]);theirs('config','user.email','other@example.com');theirs('config','user.name','Other');
 await writeFile(path.join(other,'feature.txt'),'upstream change\n');theirs('add','feature.txt');theirs('commit','-qm','upstream');theirs('push','-q','origin','HEAD:main');const upstream=theirs('rev-parse','HEAD');
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);const api=services(),callbacks={onStatusChange(){},onLogLine(){},onComplete(){}};
 // An instance that leaves the conflict unresolved fails the attempt and leaves the branch as it was.
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,FAKE_MERGE:undefined,CAPTURE:calls});cfg.recovery.enabled=false;await atomicWriteConfig(cfg,cwd);
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 let run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'blocked');assert.match(run.reason,/Conflicts with main were not resolved in feature\.txt/);
 assert.equal(git('status','--porcelain'),'');assert.equal(git('log','-1','--format=%s','iteris/1-ticket-1'),'earlier attempt');assert.throws(()=>git('rev-parse','--verify','MERGE_HEAD'));
 assert.equal(api.created.length,0);
 // A resolved merge is committed by the host and the work continues on the current base.
 process.env.FAKE_MERGE='resolve';cfg.recovery.enabled=true;await atomicWriteConfig(cfg,cwd);
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'complete',run.reason);assert.equal(api.created.length,1);
 git('merge-base','--is-ancestor',upstream,'iteris/1-ticket-1');
 assert.match(git('log','--merges','--format=%s','iteris/1-ticket-1'),/Merge main into iteris\/1-ticket-1/);
 assert.ok(!git('show','iteris/1-ticket-1:feature.txt').includes('<<<<<<<'));
 const merge=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse).filter(call=>call.prompt.startsWith('ITERIS_MERGE'));
 assert.equal(merge.length,2);assert.match(merge[0].prompt,/- feature\.txt/);assert.match(merge[0].prompt,/Do not run git merge/);
});
test('a passed review with manual follow-ups is reused while CI runs, then the task completes',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);const calls=path.join(cwd,'calls.jsonl');
 environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:'external',CAPTURE:calls});
 const cfg=config('codex');await atomicWriteConfig(cfg,cwd);let ci='waiting';
 const api={...services(),ci:async(_cfg,run)=>({state:ci,details:`unit: ${ci}`,head:run.publication.head,base:run.publication.base})},callbacks={onStatusChange(){},onLogLine(){},onComplete(){}};
 await runAllTickets([ticket(1)],cfg,cwd,callbacks,undefined,api);
 let run=await readRun(cwd,taskKey(ticket(1),cfg));assert.equal(run.state,'waiting');assert.deepEqual(run.dependencies.map(d=>d.id),['ci']);
 const reviews=async()=>(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse).filter(call=>call.prompt.startsWith('ITERIS_REVIEW')).length,before=await reviews();
 const {runWorker}=await import('../dist/lifecycle/worker.js'),probe=()=>runWorker({cwd,config:cfg,once:true,force:true,services:api,callbacks,adapter:()=>({refresh:async task=>task})});
 await probe();assert.equal((await readRun(cwd,run.key)).state,'waiting');
 ci='passed';await probe();run=await readRun(cwd,run.key);assert.equal(run.state,'complete',run.reason);
 assert.equal(await reviews(),before);
});
test('a generated description loses the remarks, code fence and task reference a model adds around it',()=>{
 assert.equal(cleanDescription('I’m using the PR skill to focus the description.\n\n## Summary\n- Outcome.\n\nCloses #1','Closes #1'),'## Summary\n- Outcome.');
 assert.equal(cleanDescription('```markdown\n## Summary\n- Outcome.\n```','Closes #1'),'## Summary\n- Outcome.');
 assert.equal(cleanDescription('Plain text without headings.','Closes #1'),'Plain text without headings.');
});
