import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {configSchema,atomicWriteConfig} from '../dist/config.js';
import {ticketBranch} from '../dist/types.js';
import {ensureRun,saveRun,readRun,listRuns,taskKey,rebindLegacyIdentity,taskFingerprint} from '../dist/lifecycle/state.js';
import {extractRequirements,addEvidence,reconcileEvidence} from '../dist/lifecycle/requirements.js';
import {commandSchema} from '../dist/lifecycle/config.js';
import {prepareEnvironment,setupBudget} from '../dist/lifecycle/environment.js';
import {sourceAdapter} from '../dist/lifecycle/adapters.js';
import {advanceCompletion,enqueueAction} from '../dist/lifecycle/stages.js';
import {runWorker} from '../dist/lifecycle/worker.js';
import {planningSchema,applyPlanningPack} from '../dist/lifecycle/planning.js';
import {lifecycleCommand} from '../dist/lifecycle/cli.js';
import {requestCancellation} from '../dist/lifecycle/cancellation.js';
import {acquireRun} from '../dist/state/active.js';
import {savePendingQueue} from '../dist/state/queue.js';
import {replaceLifecycleSection,reviewSection} from '../dist/github/pr.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {runHarness} from '../dist/harness/process.js';
import {verifyGithubCi} from '../dist/lifecycle/github-verification.js';
import {importLegacyArtifacts} from '../dist/lifecycle/migration.js';
import {identifyItems} from '../dist/custom/identity.js';
import {ticketReference} from '../dist/agent/pr-description.js';
import {temporary,config,reviewRepository,executable,environment,fakeAgent,completionServices,setupIsolationFixture} from './helpers.mjs';

const ticket=(number=1)=>({source:{provider:'github',namespace:'org/repo',id:`source-${number}`},number,title:'Feature',body:'Implement feature',slug:'feature',labels:[],htmlUrl:`https://example.com/task/${number}`});
const callbacks={onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,state)=>assert.fail(state.failureReason)};
const command=script=>commandSchema.parse({executable:process.execPath,args:['-e',script]});
async function pending(t) {
 const cwd=await temporary(t),cfg=config('codex'),task=ticket();
 const run=await ensureRun(cwd,task,cfg,path.join(cwd,'.iteris/artifacts'),ticketBranch(task));
 run.requirements=extractRequirements(task,cfg);run.publication={url:'https://example.com/pr',number:1,head:'head',base:'base',draft:true};
 for(const requirement of run.requirements.filter(r=>['local','review','publication'].includes(r.stage)))addEvidence(run,requirement.id,'head','fixture','verified',true,'base');
 await saveRun(cwd,run);return {cwd,cfg,run};
}
const apiFor=()=>{const prs=new Map();return {...completionServices,findPr:async(_,branch)=>prs.get(branch),createPr:async(_,input)=>{assert.equal(prs.has(input.branch),false);const pr={url:`https://example.com/pr/${prs.size+1}`,number:prs.size+1};prs.set(input.branch,pr);return pr;},addLabel:async()=>{},moveCard:async()=>assert.fail('provider mismatch'),prs};};

test('configuration examples validate without enabling unconfigured external actions',async()=>{
 for(const file of ['lifecycle-minimal.json','lifecycle-extended.json'])assert.equal(configSchema.parse(JSON.parse(await readFile(new URL(`../docs/examples/${file}`,import.meta.url),'utf8'))).version,3);
});
test('changed content invalidates planning but preserves interrupted external intent',async t=>{
 const {cwd,cfg,run}=await pending(t);run.plan='obsolete plan';run.planning={plan:'obsolete'};const action=enqueueAction(run,'stage','deploy','head',false);action.status='executing';action.startedAt=new Date().toISOString();await saveRun(cwd,run);
 const revised=await ensureRun(cwd,{...run.ticket,body:'Implement revised behavior'},cfg,run.artifacts,run.branch);
 assert.equal(revised.plan,undefined);assert.equal(revised.planning,undefined);assert.equal(revised.actions[0].operationId,action.operationId);assert.equal(revised.actions[0].status,'executing');
 revised.publication.head='new-head';revised.requirements=extractRequirements(revised.ticket,cfg);await advanceCompletion(cfg,revised,cwd,completionServices);assert.equal(revised.state,'waiting');assert.ok(revised.dependencies.some(d=>d.id===`action:${action.id}`));
});
test('latest failed evidence cannot reuse an earlier successful result at unchanged HEAD',async t=>{
 const {run}=await pending(t);addEvidence(run,'local-checks','head','fixture','failed invariant',false,'base');reconcileEvidence(run,'head','base');assert.equal(run.requirements.find(r=>r.id==='local-checks').status,'pending');
});
test('legacy identity conflict leaves original identity intact',async t=>{
 const {cwd,cfg,run}=await pending(t);run.source.id=String(run.ticket.number);run.ticket.source=run.source;run.key=taskKey(run.ticket,cfg);enqueueAction(run,'source-status',undefined,'head',true);
 const original=structuredClone(run);await assert.rejects(rebindLegacyIdentity(cwd,run,{...run.ticket,source:{...run.source,id:'node-stable'}},cfg),/Pending legacy actions/);assert.deepEqual(run,original);
});
test('stable source branches remain unique even for thousands of identical display titles',()=>{
 const branches=new Set(Array.from({length:2000},(_,i)=>ticketBranch({...ticket(),source:{provider:'command',namespace:'fixture',id:String(i)}})));assert.equal(branches.size,2000);
});
test('command source diagnostics on stderr do not corrupt the versioned stdout protocol',async t=>{
 const cwd=await temporary(t),cfg=configSchema.parse({...config(),provider:'command',integrations:{source:{name:'fixture',namespace:'fixture',command:command("console.error('diagnostic');console.log(JSON.stringify({version:1,ok:true,tasks:[{id:'stable',number:1,title:'Feature',body:'Implement feature',labels:[],url:''}]}))")}}});
 assert.equal((await sourceAdapter(cfg,cwd).fetch())[0].source.id,'stable');
});
test('credential changes invalidate local-check cache identity without persisting the value',async t=>{
 const cwd=await temporary(t);environment(t,{CHECK_TOKEN:'first'});const cfg=configSchema.parse({...config(),verification:{checks:[{id:'credential',command:{executable:process.execPath,env:{TOKEN:'CHECK_TOKEN'}}}]}});const first=(await prepareEnvironment(cfg,cwd)).identity;process.env.CHECK_TOKEN='second';assert.notEqual((await prepareEnvironment(cfg,cwd)).identity,first);
});
test('structured planning preserves host gates and stable obligations across replanning',async t=>{
 const {run}=await pending(t);const pack=planningSchema.parse({plan:'Plan',requirements:[...run.requirements.map(({id,text,stage,method})=>({id,text,stage:id==='local-checks'?'deployment':stage,method})),{id:'behavior',text:'Preserve existing behavior',stage:'local',method:'behavioral-check'}],invariants:['Behavior remains available'],reproductionStrategy:'Exercise fixture',fixtures:['fixture'],capabilities:['local'],checks:[{command:'printf behavioral-evidence',behavioral:true,requirementIds:['behavior']}]});
 applyPlanningPack(run,pack);const id=pack.checks[0].requirementIds[0];assert.equal(run.requirements.find(r=>r.id==='local-checks').stage,'local');applyPlanningPack(run,pack);assert.equal(run.requirements.filter(r=>r.id===id).length,1);
});
test('PR completion projections preserve independent review and authored descriptions',()=>{
 const original=`Authored summary\n${reviewSection('Independent review')}`;const next=replaceLifecycleSection(original,'waiting: device');assert.match(next,/Independent review/);assert.equal(replaceLifecycleSection(next,'complete'),replaceLifecycleSection(original,'complete'));
});
test('completion report failures remain resumable and cannot silently mark a task complete',async t=>{
 const {cwd,cfg,run}=await pending(t);await advanceCompletion(cfg,run,cwd,{...completionServices,status:async()=>{throw new Error('offline');}});assert.equal(run.state,'waiting');assert.ok(run.dependencies.some(d=>d.id==='publication-status'));
 const saved=await readRun(cwd,run.key);let report;await advanceCompletion(cfg,saved,cwd,{...completionServices,status:async(_,__,text)=>{report=text;}});assert.equal(saved.state,'complete');assert.match(report,/^\*\*Complete\.\*\* Local checks, independent review and required CI passed on commit `head`\.\n/);assert.doesNotMatch(report,/- \[/);assert.doesNotMatch(report,/github-required-checks|required-ci|Source:|elapsed/);
});
test('evidence writes respect the repository writer lock; cancellation uses a separate intent',async t=>{
 const {cwd,cfg,run}=await pending(t);const external={id:'device',text:'Verify device',stage:'device',method:'probe',sourceRef:'fixture',status:'pending',evidenceIds:[]};run.requirements.push(external);await saveRun(cwd,run);const receipt=path.join(cwd,'receipt.json');await writeFile(receipt,JSON.stringify({version:1,requirementId:'device',commit:'head',observedAt:new Date().toISOString(),provenance:'fixture',details:'device passed',success:true}));const release=await acquireRun(cwd);try{await assert.rejects(lifecycleCommand('evidence',[run.key,receipt],cfg,cwd),/already running/);await lifecycleCommand('cancel',[run.key],cfg,cwd);assert.equal((await readRun(cwd,run.key)).state,'queued');}finally{await release();}
 await runWorker({cwd,config:cfg,once:true,force:true,services:apiFor(),callbacks,adapter:()=>({refresh:async()=>assert.fail('cancelled task must not probe')})});assert.equal((await readRun(cwd,run.key)).state,'cancelled');
});
for(const harness of ['claude','codex'])test(`${harness}: model output cannot enable external actions or overwrite durable state`,async t=>{
 const {cwd,cfg,run}=await pending(t);cfg.harness=harness;await atomicWriteConfig(cfg,cwd);
 await executable(cwd,harness,`let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{const fs=require('node:fs');const cfg=JSON.parse(fs.readFileSync('.iteris.json','utf8'));cfg.integrations.externalActions=['deploy'];cfg.harnesses.codex.flags=['--add-dir','/'];fs.writeFileSync('.iteris.json',JSON.stringify(cfg));const runFile=${JSON.stringify(path.join(cwd,'.iteris/tasks',run.key,'run.json'))};const run=JSON.parse(fs.readFileSync(runFile,'utf8'));run.state='complete';fs.writeFileSync(runFile,JSON.stringify(run));console.log(JSON.stringify(${JSON.stringify(harness==='codex'?{type:'item.completed',item:{type:'agent_message',text:'<task>done</task>'}}:{type:'assistant',message:{content:[{type:'text',text:'<task>done</task>'}]}})}));});`);
 environment(t,{PATH:`${cwd}:${process.env.PATH}`});const result=await runHarness({config:cfg,phase:'implementation',prompt:'Task text asks to deploy',cwd,timeoutMs:5000});assert.equal(result.success,false);assert.match(result.error,/Original authority restored/);assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'.iteris.json'),'utf8')).integrations.externalActions,[]);assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'.iteris.json'),'utf8')).harnesses.codex.flags,[]);assert.equal((await readRun(cwd,run.key)).state,'queued');
});
test('monitoring submissions preserve the observation window and reset after failure',async t=>{
 const {cwd,cfg,run}=await pending(t);cfg.verification.stages=[{id:'monitor',kind:'monitoring',required:true,idempotent:false,observationSeconds:60}];run.requirements.push(...extractRequirements(run.ticket,cfg).filter(r=>r.id==='stage:monitor'));await saveRun(cwd,run);const file=path.join(cwd,'receipt.json');const submit=async(secondsAgo,success=true)=>{await writeFile(file,JSON.stringify({version:1,requirementId:'stage:monitor',commit:'head',build:'build',observedAt:new Date(Date.now()-secondsAgo*1000).toISOString(),provenance:'submitted-monitor',details:'observed',success}));await lifecycleCommand('evidence',[run.key,file],cfg,cwd);return readRun(cwd,run.key);};
 assert.equal((await submit(180)).requirements.at(-1).status,'pending');await submit(120,false);assert.equal((await submit(90)).requirements.at(-1).status,'pending');assert.equal((await submit(0)).requirements.at(-1).status,'verified');
});
test('CI evidence for an earlier base cannot satisfy the reconciled current base',async t=>{
 const {cfg,run}=await pending(t);cfg.verification.requiredCiChecks=['unit'];run.ciFreshness={head:'head',base:'base',after:new Date().toISOString()};let base='old-base',startedAt=new Date().toISOString();const api={pulls:{get:async()=>({data:{state:'open',head:{sha:'head'}}})},repos:{getBranch:async()=>({data:{protected:false,commit:{sha:'base'}}}),listCommitStatusesForRef(){}},checks:{listForRef(){}},paginate:async method=>method===api.checks.listForRef?[{name:'unit',status:'completed',conclusion:'success',started_at:startedAt,pull_requests:[{base:{sha:base}}]}]:[]};assert.equal((await verifyGithubCi(cfg,run,api)).state,'waiting');base='base';assert.equal((await verifyGithubCi(cfg,run,api)).state,'passed');startedAt='2000-01-01T00:00:00.000Z';assert.equal((await verifyGithubCi(cfg,run,api)).state,'waiting');
});
test('failed CI invalidates prior success and prevents source completion or deployment',async t=>{
 const {cwd,cfg,run}=await pending(t);addEvidence(run,'required-ci','head','github-required-checks','previous pass',true,'base');cfg.integrations.status.github={command:command('process.exit(1)'),idempotent:true};cfg.integrations.externalActions=['deploy'];cfg.verification.stages=[{id:'deploy',kind:'deployment',required:true,idempotent:true,observationSeconds:0,verify:command('process.exit(1)'),execute:command("require('node:fs').writeFileSync('unexpected-deployment','bad')")}];
 await advanceCompletion(cfg,run,cwd,{...completionServices,ci:async()=>({state:'failed',details:'unit failed',head:'head',base:'base'}),synchronize:async()=>assert.fail('failed CI cannot complete a source task')});assert.equal(run.state,'waiting');assert.equal(run.requirements.find(r=>r.id==='required-ci').status,'pending');await assert.rejects(readFile(path.join(cwd,'unexpected-deployment')),/ENOENT/);
});
test('resolved legacy Trello identity clears the waiting condition and preserves the original run',async t=>{
 const {cwd,cfg,run}=await pending(t);cfg.provider='trello';cfg.trello={boardId:'board'};run.source={provider:'trello',namespace:'board',id:'legacy:1'};run.ticket.source=run.source;run.key=taskKey(run.ticket,cfg);run.dependencies=[{id:'trello-identity',kind:'capability',description:'Legacy identity',nextAction:'Resolve full ID',attempts:1,nextRetryAt:new Date().toISOString()}];await saveRun(cwd,run);const oldKey=run.key;
 await rebindLegacyIdentity(cwd,run,{...run.ticket,source:{...run.source,id:'full-card-id'}},cfg);assert.notEqual(run.key,oldKey);assert.equal(run.dependencies.length,0);assert.equal((await readRun(cwd,oldKey)).state,'cancelled');assert.equal((await readRun(cwd,run.key)).source.id,'full-card-id');
});
test('persistent repair budgets cannot reset through resume or empty commits',async t=>{
 const {cwd,git}=await reviewRepository(t);git('checkout','-qb','iteris/1-feature');await writeFile(path.join(cwd,'feature.txt'),'broken\n');git('add','feature.txt');git('commit','-qm','broken');await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_MODE:undefined,REVIEW_SCENARIO:'no-repair',CAPTURE:path.join(cwd,'calls.jsonl')});const cfg=config('codex');const options={ticket:ticket(),config:cfg,cwd,folder:path.join(cwd,'.iteris/review'),onLogLine(){},onProcess(){}};
 assert.equal((await runCodeReview(options)).report.repairs,1);assert.equal((await runCodeReview(options)).report.repairs,1);git('commit','--allow-empty','-qm','prose changed');assert.equal((await runCodeReview(options)).report.repairs,0);assert.equal((await readFile(path.join(cwd,'calls.jsonl'),'utf8')).split('\n').filter(line=>line.includes('ITERIS_REPAIR')).length,2);
});
test('historical Roxbase census replays conservatively without touching the source repository',async t=>{
 const audit=JSON.parse(await readFile(new URL('../docs/audits/roxbase-2026-09-30/census.json',import.meta.url),'utf8'));const {cwd,git}=await reviewRepository(t);const cfg=config('codex');cfg.provider='custom';cfg.custom={endpoint:'https://fixture.example/tasks',apiKeyEnv:'UNUSED_FIXTURE_TOKEN'};let imported=0;
 for(const task of audit.tasks){const identity=path.basename(task.artifact_directory).replace('custom-',''),branch=`iteris/replay-${task.number}`,ticket={number:task.number,title:task.title,body:'Reconcile the original task acceptance requirements',slug:`replay-${task.number}`,labels:[],htmlUrl:'',custom:{identity,fingerprint:'historical',taskFile:'fixture',branch}};git('branch',branch);const head=git('rev-parse',branch),legacy=path.join(cwd,'.iteris/runs',`custom-${identity}`);await mkdir(path.join(legacy,'review'),{recursive:true});await writeFile(path.join(legacy,'review/context.json'),JSON.stringify({ticket,stamp:{head,branch},auditOriginalHead:task.review_head}));await writeFile(path.join(legacy,'review/result.json'),JSON.stringify({outcome:task.review_outcome,reason:task.reason}));await writeFile(path.join(legacy,'status.md'),`**Status**: done\n**PR**: https://github.com/org/repo/pull/${task.pr}\n`);const run=await importLegacyArtifacts(cwd,ticket,cfg,path.join(cwd,'.iteris/tasks',taskKey(ticket,cfg),'artifacts'));assert.equal(run.state,'queued');assert.equal(run.publication.number,task.pr);assert.equal(run.implementation.head,head);assert.equal(run.evidence.length,0);imported++;}
 assert.equal(imported,14);assert.equal(audit.tasks.filter(t=>['blocked','incomplete'].includes(t.review_outcome)).length,12);
});
test('legacy pending queue becomes durable before unavailable source probes',async t=>{
 const {cwd,cfg,run}=await pending(t);run.state='waiting';await saveRun(cwd,run);await savePendingQueue(cwd,cfg,[ticket(2)]);await runWorker({cwd,config:cfg,once:true,force:true,services:apiFor(),callbacks,adapter:()=>({refresh:async()=>{throw new Error('source offline');}})});assert.equal((await listRuns(cwd)).length,2);
});
test('setup failures consume a durable budget while manual prerequisite recovery still probes successfully',async t=>{
 const {cwd,cfg,run}=await pending(t);await setupIsolationFixture(cwd);environment(t,{PATH:`${cwd}:${process.env.PATH}`});const binary=path.join(cwd,'runtime');cfg.environment.runtimes=[{id:'runtime',executable:binary,versionArgs:['--version'],setup:command('process.exit(1)')}];
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(prepareEnvironment(cfg,cwd,undefined,undefined,setupBudget(cwd,run,cfg)),/setup failed/);
 const saved=await readRun(cwd,run.key);await assert.rejects(prepareEnvironment(cfg,cwd,undefined,undefined,setupBudget(cwd,saved,cfg)),/budget exhausted/);await executable(cwd,'runtime',"console.log('ready')");assert.equal((await prepareEnvironment(cfg,cwd,undefined,undefined,setupBudget(cwd,saved,cfg))).versions.runtime,'ready');
});
test('unchanged custom sources refresh without model conversion or task-path drift',async t=>{
 const cwd=await temporary(t),cfg=configSchema.parse({...config('codex'),provider:'custom',custom:{endpoint:'https://fixture.example/tasks',apiKeyEnv:'FIXTURE_TOKEN'}}),payload=[{id:'task',title:'Feature',body:'Implement feature'}];const item=identifyItems(payload,cfg.custom).items[0];const task={...ticket(),source:undefined,custom:{identity:item.identity,fingerprint:item.fingerprint,taskFile:'original/task.md'},body:'Original normalized acceptance'};environment(t,{FIXTURE_TOKEN:'fixture-token'});const original=global.fetch;t.after(()=>{global.fetch=original;});global.fetch=async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
 assert.equal(await sourceAdapter(cfg,cwd).refresh(task),task);assert.equal(taskFingerprint({...task,title:'Display changed',body:'A different cache path'}),taskFingerprint(task));await assert.rejects(readFile(path.join(cwd,'.iteris/active.json')),/ENOENT/);
});
test('GitHub Projects refresh and references use the source issue repository',async t=>{
 const cwd=await temporary(t),cfg=config(),task={...ticket(),htmlUrl:'https://github.com/source/repository/issues/1',source:{provider:'github',namespace:'owner/project/1',id:'project-item',projectItemId:'project-item',issueId:'issue-node'}};const api={issues:{get:async input=>{assert.equal(input.owner,'source');assert.equal(input.repo,'repository');return {data:{id:42,node_id:'issue-node',title:'Feature',body:'Implement feature',labels:[]}};}}};assert.equal((await sourceAdapter(cfg,cwd,api).refresh(task)).source.projectItemId,'project-item');assert.equal(ticketReference(task,cfg),'Closes source/repository#1');assert.notEqual(ticketBranch(task),ticketBranch(ticket()));
});

for(const harness of ['claude','codex'])for(const phase of ['planning','running','reviewing','creating-pr','summarizing'])test(`${harness}: restart after ${phase} retains all tasks and verifies the published commit`,async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});const cfg=config(harness);await atomicWriteConfig(cfg,cwd);
 const api=apiFor(),controller=new AbortController();let interrupted=false;
 await runAllTickets([ticket(),ticket(2)],cfg,cwd,{...callbacks,onStatusChange(_,state){if(!interrupted && state.status===phase){interrupted=true;controller.abort();}}},controller.signal,api);
 assert.equal(interrupted,true);assert.equal((await listRuns(cwd)).length,2);
 await runWorker({cwd,config:cfg,once:true,force:true,services:api,callbacks,adapter:()=>({refresh:async task=>task})});
 for(const run of await listRuns(cwd)){assert.equal(run.state,'complete',run.reason);const report=JSON.parse(await readFile(path.join(run.artifacts,'review/result.json'),'utf8'));assert.equal(report.stamp.head,run.publication.head);assert.ok(run.evidence.filter(e=>e.success).some(e=>e.commit===run.publication.head && e.requirementId==='independent-review'));}
 assert.equal(api.prs.size,2);
});
test('active cancellation terminates the harness and remains cancelled after restart',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_MODE:'hang'});const cfg=config('codex');cfg.planMode=false;await atomicWriteConfig(cfg,cwd);let cancelling;
 await runAllTickets([ticket()],cfg,cwd,{...callbacks,onStatusChange(_,state){if(!cancelling && state.status==='running')cancelling=requestCancellation(cwd,taskKey(ticket(),cfg));}},undefined,apiFor());await cancelling;assert.equal((await readRun(cwd,taskKey(ticket(),cfg))).state,'cancelled');
 await runWorker({cwd,config:cfg,once:true,force:true,services:apiFor(),callbacks,adapter:()=>({refresh:async()=>assert.fail('cancelled task resumed')})});
});
test('failed CI repair publishes a new commit with fresh checks and independent review',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:undefined});const cfg=config('codex');cfg.planMode=false;cfg.verification.requiredCiChecks=['unit'];await atomicWriteConfig(cfg,cwd);const task={...ticket(),slug:'ticket-1'},api=apiFor();let failedHead;
 api.ci=async(_,run)=>{failedHead??=run.publication.head;return {head:run.publication.head,base:run.publication.base,state:run.publication.head===failedHead?'failed':'passed',details:'unit invariant'};};
 await runAllTickets([task],cfg,cwd,callbacks,undefined,api);let run=await readRun(cwd,taskKey(task,cfg));assert.equal(run.state,'waiting');process.env.REVIEW_SCENARIO='recover-ticket-failure';
 await runWorker({cwd,config:cfg,once:true,force:true,services:api,callbacks,adapter:()=>({refresh:async task=>task})});run=await readRun(cwd,run.key);assert.equal(run.state,'complete',run.reason);assert.notEqual(run.publication.head,failedHead);assert.equal(JSON.parse(await readFile(path.join(run.artifacts,'review/result.json'),'utf8')).stamp.head,run.publication.head);assert.equal(api.prs.size,1);
});
test('unchanged-HEAD resume clears recovered local prerequisites and transport without repeating implementation',async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});const cfg=config('codex');cfg.provider='github';cfg.planMode=false;await atomicWriteConfig(cfg,cwd);const api=apiFor();await runAllTickets([ticket()],cfg,cwd,callbacks,undefined,api);const run=await readRun(cwd,taskKey(ticket(),cfg)),head=run.publication.head;run.state='waiting';run.dependencies=[{id:'preflight',kind:'environment',description:'Runtime was unavailable',nextAction:'Restore runtime',attempts:1,nextRetryAt:new Date().toISOString()},{id:'running',kind:'transport',description:'Harness transport was unavailable',nextAction:'Restore transport',attempts:1,nextRetryAt:new Date().toISOString()}];await saveRun(cwd,run);const before=await readFile(path.join(cwd,'calls.jsonl'),'utf8');
 await runWorker({cwd,config:cfg,once:true,force:true,services:api,callbacks,adapter:()=>({refresh:async task=>task})});const resumed=await readRun(cwd,run.key);assert.equal(resumed.state,'complete',resumed.reason);assert.equal(resumed.publication.head,head);assert.equal(resumed.dependencies.length,0);assert.equal(await readFile(path.join(cwd,'calls.jsonl'),'utf8'),before);
});
