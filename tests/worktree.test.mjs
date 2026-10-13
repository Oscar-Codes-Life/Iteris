import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, symlink, stat, access} from 'node:fs/promises';
import path from 'node:path';
import {copyWorktreeFiles, prepareTaskWorkspace} from '../dist/lifecycle/worktree.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {runWorker} from '../dist/lifecycle/worker.js';
import {listRuns, readRun, taskKey, sourceIdentity} from '../dist/lifecycle/state.js';
import {loadPendingQueue} from '../dist/state/queue.js';
import {hasActiveRun} from '../dist/state/active.js';
import {atomicWriteConfig, loadConfig} from '../dist/config.js';
import {configure} from '../dist/setup.js';
import {readInstances} from '../dist/ui/InstanceMonitor.js';
import {runPool} from '../dist/state/pool.js';
import {temporary, config, reviewRepository, executable, environment, fakeAgent} from './helpers.mjs';

const ticket = number => ({number, title:`Ticket ${number}`, body:'Implement feature', slug:`ticket-${number}`, labels:[], htmlUrl:`https://example.com/${number}`});
const callbacks = {onStatusChange(){}, onLogLine(){}, onComplete(){}, onFailure:async(_, state)=>assert.fail(state.failureReason)};

for (const harness of ['claude','codex']) test(`${harness} copies ignored include patterns, preserves destinations and skips unavailable files`, async t => {
 const {cwd,git}=await reviewRepository(t), dest=await temporary(t), outside=await temporary(t);
 await writeFile(path.join(cwd,'.gitignore'), '.env*\nconfig/\nAGENTS.override.md\n');
 await writeFile(path.join(cwd,'.worktreeinclude'), '# local configuration\n.env*\n!.env.skip\nconfig/\nmissing-file\nfeature.txt\n');
 await writeFile(path.join(cwd,'.env'), 'SECRET=example\n', {mode:0o600});
 await writeFile(path.join(cwd,'.env.local'), 'LOCAL=yes\n');
 await writeFile(path.join(cwd,'.env.skip'), 'no');
 await writeFile(path.join(cwd,'AGENTS.override.md'),'local instructions');
 await mkdir(path.join(cwd,'config')); await writeFile(path.join(cwd,'config/settings.json'),'{}');
 await writeFile(path.join(outside,'secret'),'outside');
 await symlink(path.join(outside,'secret'),path.join(cwd,'.env.link'));
 await symlink(outside,path.join(cwd,'config/linked'));
 await writeFile(path.join(dest,'.env.local'),'keep destination');
 await mkdir(path.join(dest,'config')); await symlink(path.join(outside,'secret'),path.join(dest,'config/settings.json'));
 git('add','.gitignore','.worktreeinclude'); git('commit','-qm','ignore fixtures');
 const messages=[]; const result=await copyWorktreeFiles(cwd,dest,harness,line=>messages.push(line));
 assert.equal(await readFile(path.join(dest,'.env'),'utf8'),'SECRET=example\n');
 assert.equal((await stat(path.join(dest,'.env'))).mode & 0o777,0o600);
 assert.equal(await readFile(path.join(dest,'.env.local'),'utf8'),'keep destination');
 assert.equal(await readFile(path.join(outside,'secret'),'utf8'),'outside');
 for(const name of ['.env.skip','.env.link','feature.txt','config/linked/secret']) await assert.rejects(access(path.join(dest,name)));
 assert.equal(result.copied,harness==='codex'?2:1); assert.ok(result.skipped>=3);
 assert.ok(!messages.join('').includes('SECRET=example'));
 if(harness==='codex') assert.equal(await readFile(path.join(dest,'AGENTS.override.md'),'utf8'),'local instructions');
});

test('missing include file is optional and safe destination directories can be created', async t=>{
 const {cwd}=await reviewRepository(t),dest=await temporary(t);
 assert.deepEqual(await copyWorktreeFiles(cwd,dest,'claude'),{copied:0,skipped:0});
 await writeFile(path.join(cwd,'.gitignore'),'config/\n'); await mkdir(path.join(cwd,'config'));
 await writeFile(path.join(cwd,'config/.env'),'deep'); await writeFile(path.join(cwd,'.worktreeinclude'),'config/\n');
 assert.equal((await copyWorktreeFiles(cwd,dest,'claude')).copied,1);
 assert.equal(await readFile(path.join(dest,'config/.env'),'utf8'),'deep');
});

for (const harness of ['claude','codex']) test(`${harness} overlaps worktree tasks, persists central state, and resumes in the same checkouts`, async t => {
 const {cwd,git}=await reviewRepository(t); const cfg=config(harness); cfg.workspace={mode:'worktree',concurrency:2}; cfg.planMode=false;
 cfg.continuation.watch=false;
 await writeFile(path.join(cwd,'.gitignore'),'.env\n'); await writeFile(path.join(cwd,'.worktreeinclude'),'.env\nmissing.env\n');
 git('add','.gitignore','.worktreeinclude'); git('commit','-qm','worktree setup'); git('push','-q','origin','main');
 await writeFile(path.join(cwd,'.env'),'COPIED=yes\n');
 const tools=await temporary(t), barrier=path.join(tools,'started');
 const script=fakeAgent.replace("if (process.env.FAKE_IMPLEMENT === '1'", `if(prompt.startsWith('You are an autonomous')) {
 fs.appendFileSync(process.env.BARRIER,process.cwd()+'\\n');
 if(fs.readFileSync('.env','utf8')!=='COPIED=yes\\n') throw new Error('Missing local setup');
 const deadline=Date.now()+5000;
 while(fs.readFileSync(process.env.BARRIER,'utf8').trim().split('\\n').length<2) {if(Date.now()>deadline)throw new Error('Tasks did not overlap');await new Promise(r=>setTimeout(r,20));}
 await new Promise(r=>setTimeout(r,150));
 }
 if (process.env.FAKE_IMPLEMENT === '1'`);
 await executable(tools,harness,script); environment(t,{PATH:`${tools}:${process.env.PATH}`, BARRIER:barrier, FAKE_IMPLEMENT:'1'});
 await atomicWriteConfig(cfg,cwd);
 let inFlight=new Set(),maxActive=0,ciPassed=false;
 const api={findPr:async()=>undefined,createPr:async(_cfg,input)=>({number:Number(input.branch.split('/')[1].split('-')[0]),url:'https://example.com/pr'}),addLabel:async()=>{},moveCard:async()=>{},draft:async()=>{},ci:async(_cfg,run)=>({state:ciPassed?'passed':'pending',details:'fixture CI',head:run.publication.head,base:run.publication.base})};
 await runAllTickets([ticket(1),ticket(2),ticket(3)],cfg,cwd,{...callbacks,onStatusChange(number,state){
  if(['running','reviewing','creating-pr','summarizing'].includes(state.status))inFlight.add(number);else inFlight.delete(number);
  maxActive=Math.max(maxActive,inFlight.size);
 }},undefined,api);
 assert.equal(maxActive,2); assert.equal(git('branch','--show-current'),'main');
 assert.equal(await readFile(path.join(cwd,'feature.txt'),'utf8'),'base\n');
 const runs=await listRuns(cwd,cfg.repo); assert.equal(runs.length,3); assert.ok(runs.every(run=>run.workspace.mode==='worktree'));
 assert.equal(new Set(runs.map(run=>run.workspace.path)).size,3);
 assert.equal(await hasActiveRun(cwd),false); assert.equal(await loadPendingQueue(cwd,cfg),undefined);
 for(const run of runs) {
  assert.equal(run.state,'waiting',run.reason);
  assert.equal(await readFile(path.join(run.workspace.path,'feature.txt'),'utf8'),`implemented ${run.branch}\n`);
  assert.match(run.artifacts,new RegExp('/\\.iteris/tasks/'));
  await writeFile(path.join(run.workspace.path,'.env'),'KEEP=on-resume\n');
 }
 const instances=await readInstances(cwd,cfg); assert.equal(instances.length,3); assert.ok(instances.every(state=>state.workspace && state.selection.harness===harness));
 ciPassed=true; cfg.workspace.mode='local'; await atomicWriteConfig(cfg,cwd);
 await runWorker({config:cfg,cwd,callbacks,once:true,force:true,services:api,adapter:()=>({refresh:async current=>({...current,source:sourceIdentity(current,cfg)})})});
 for(const run of await listRuns(cwd,cfg.repo)) {
  assert.equal(run.state,'complete',run.reason); assert.equal(run.workspace.mode,'worktree');
  assert.equal(await readFile(path.join(run.workspace.path,'.env'),'utf8'),'KEEP=on-resume\n');
 }
 assert.equal(git('branch','--show-current'),'main');
});

test('workspace settings persist without harness discovery and invalid parallelism is rejected', async t=>{
 const cwd=await temporary(t);await atomicWriteConfig(config(),cwd);
 await configure('workspace','worktree',{cwd});await configure('parallel','4',{cwd});
 assert.deepEqual((await loadConfig(cwd)).workspace,{mode:'worktree',concurrency:4});
 for(const bad of ['0','9','2.5','2x']) await assert.rejects(configure('parallel',bad,{cwd}));
 await assert.rejects(configure('workspace','unknown',{cwd}));
});

test('pool stops starting jobs on failure and drains every started job',async()=>{
 const started=[],finished=[];
 await assert.rejects(runPool([1,2,3],2,async value=>{started.push(value);await new Promise(r=>setTimeout(r,value===1?10:40));finished.push(value);if(value===1)throw new Error('failure');}),/failure/);
 assert.deepEqual(started,[1,2]);assert.deepEqual(finished,[1,2]);
});

test('interrupted parallel queue resumes every queued task through the worker', async t=>{
 const {cwd,git}=await reviewRepository(t),tools=await temporary(t),cfg=config('codex');cfg.workspace={mode:'worktree',concurrency:2};cfg.planMode=false;cfg.continuation.watch=false;
 await executable(tools,'codex',fakeAgent);environment(t,{PATH:`${tools}:${process.env.PATH}`,FAKE_IMPLEMENT:'1'});await atomicWriteConfig(cfg,cwd);
 const controller=new AbortController();
 const api={findPr:async()=>undefined,createPr:async()=>({number:1,url:'https://example.com/pr'}),addLabel:async()=>{},moveCard:async()=>{},draft:async()=>{},ci:async(_cfg,run)=>({state:'passed',details:'fixture CI',head:run.publication.head,base:run.publication.base})};
 await runAllTickets([ticket(1),ticket(2),ticket(3)],cfg,cwd,{...callbacks,onStatusChange(_,state){if(state.status==='running')controller.abort();}},controller.signal,api);
 assert.equal((await listRuns(cwd,cfg.repo)).length,3);
 await runWorker({config:cfg,cwd,callbacks,once:true,force:true,services:api,adapter:()=>({refresh:async current=>({...current,source:sourceIdentity(current,cfg)})})});
 const runs=await listRuns(cwd,cfg.repo);assert.equal(runs.length,3);for(const run of runs)assert.equal(run.state,'complete',run.reason);
 assert.equal(git('branch','--show-current'),'main');
});

test('cancelling one running worktree leaves the other task free to complete', async t=>{
 const {requestCancellation}=await import('../dist/lifecycle/cancellation.js');
 const {cwd,git}=await reviewRepository(t),tools=await temporary(t),cfg=config('claude');cfg.workspace={mode:'worktree',concurrency:2};cfg.planMode=false;cfg.continuation.watch=false;
 await executable(tools,'claude',fakeAgent.replace("if (process.env.FAKE_IMPLEMENT === '1'", "if(prompt.startsWith('You are an autonomous')) await new Promise(r=>setTimeout(r,700));\nif (process.env.FAKE_IMPLEMENT === '1'"));
 environment(t,{PATH:`${tools}:${process.env.PATH}`,FAKE_IMPLEMENT:'1'});await atomicWriteConfig(cfg,cwd);
 const api={findPr:async()=>undefined,createPr:async()=>({number:2,url:'https://example.com/pr'}),addLabel:async()=>{},moveCard:async()=>{},draft:async()=>{},ci:async(_cfg,run)=>({state:'passed',details:'fixture CI',head:run.publication.head,base:run.publication.base})};
 let cancellation;
 await runAllTickets([ticket(1),ticket(2)],cfg,cwd,{...callbacks,onStatusChange(number,state){if(number===1 && state.status==='running')cancellation??=requestCancellation(cwd,taskKey(ticket(1),cfg));}},undefined,api);
 await cancellation;
 assert.equal((await readRun(cwd,taskKey(ticket(1),cfg))).state,'cancelled');
 assert.equal((await readRun(cwd,taskKey(ticket(2),cfg))).state,'complete');
 assert.equal(git('branch','--show-current'),'main');
});

test('a task started before worktree support retains its local checkout after changing the default',async t=>{
 const {cwd}=await reviewRepository(t),cfg=config();cfg.workspace.mode='worktree';
 const {createRunFolder}=await import('../dist/state/manager.js');const {ensureRun,saveRun}=await import('../dist/lifecycle/state.js');
 const folder=await createRunFolder(cwd,ticket(1),cfg),run=await ensureRun(cwd,ticket(1),cfg,folder,'iteris/1-ticket-1');run.plan='Existing plan';await saveRun(cwd,run);
 assert.deepEqual((await readRun(cwd,run.key)).workspace,{mode:'local',path:cwd});
});

test('duplicate source entries cannot schedule concurrent writers in the same worktree',async t=>{
 const {cwd}=await reviewRepository(t),cfg=config();cfg.workspace={mode:'worktree',concurrency:3};await atomicWriteConfig(cfg,cwd);
 let attempts=0;
 await assert.rejects(runAllTickets([ticket(1),ticket(1)],cfg,cwd,{...callbacks,beforeTicket:async()=>{attempts++;throw new Error('Prerequisite unavailable');}}),/Prerequisite unavailable/);
 assert.equal(attempts,1);assert.equal((await loadPendingQueue(cwd,cfg)).length,1);assert.equal(await hasActiveRun(cwd),false);
});
