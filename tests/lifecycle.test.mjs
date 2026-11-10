import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {configSchema,loadConfig,atomicWriteConfig} from '../dist/config.js';
import {ticketBranch} from '../dist/types.js';
import {ensureRun,saveRun,readRun,listRuns,taskKey,waitFor,recordFailure,renderRun,MANUAL_FOLLOW_UP} from '../dist/lifecycle/state.js';
import {extractRequirements,addEvidence,reconcileEvidence,readyToComplete} from '../dist/lifecycle/requirements.js';
import {resolveTaskConfig,commandSchema} from '../dist/lifecycle/config.js';
import {prepareEnvironment,persistedManifest,executeCommand} from '../dist/lifecycle/environment.js';
import {sourceAdapter} from '../dist/lifecycle/adapters.js';
import {advanceCompletion,enqueueAction} from '../dist/lifecycle/stages.js';
import {verifyGithubCi} from '../dist/lifecycle/github-verification.js';
import {schedulingOrder,runWorker} from '../dist/lifecycle/worker.js';
import {importLegacyArtifacts} from '../dist/lifecycle/migration.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {runCodeReview} from '../dist/agent/reviewer.js';
import {temporary,config,reviewRepository,executable,environment,fakeAgent,completionServices,setupIsolationFixture} from './helpers.mjs';

const ticket=(provider='github',namespace='org/repo',id='stable-1')=>({source:{provider,namespace,id},number:1,title:'Feature',body:'Implement feature',slug:'feature',labels:[],htmlUrl:`https://example.com/${provider}/${id}`});
const command=script=>commandSchema.parse({executable:process.execPath,args:['-e',script]});
const callbacks={onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async()=> 'skip'};
async function pendingRun(t,body='Implement feature'){
 const cwd=await temporary(t),cfg=config('codex'),task={...ticket(),body};
 const run=await ensureRun(cwd,task,cfg,path.join(cwd,'.iteris/artifacts'),ticketBranch(task));run.requirements=extractRequirements(task,cfg);
 run.publication={url:'https://example.com/pr',number:1,head:'commit-a',base:'base-a',draft:true};
 for(const requirement of run.requirements.filter(r=>['local','review','publication'].includes(r.stage)))addEvidence(run,requirement.id,'commit-a','fixture','verified fixture',true,'base-a');
 await saveRun(cwd,run);return {cwd,cfg,run};
}
test('v2 migration backs up exact settings and supplies v3 defaults',async t=>{
 const cwd=await temporary(t),old={version:2,repo:'org/repo',provider:'trello',trello:{boardId:'board'},baseBranch:'develop',qualityChecks:['test command'],harness:'codex',harnesses:{codex:{model:'pinned',flags:[]}},pr:{draft:true}};
 await writeFile(path.join(cwd,'.iteris.json'),JSON.stringify(old));const cfg=await loadConfig(cwd);
 assert.equal(cfg.version,3);assert.equal(cfg.baseBranch,'develop');assert.deepEqual(cfg.qualityChecks,old.qualityChecks);assert.equal(cfg.harnesses.codex.model,'pinned');assert.equal(cfg.pr.draft,true);assert.equal(cfg.recovery.finalVerificationReserve,.2);assert.equal(cfg.continuation.initialSeconds,60);assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'.iteris.json.v2.bak'),'utf8')),old);
});
test('provider, repository and namespace prevent numeric-ID collisions; titles do not define identity',()=>{
 const cfg=config();const a=ticket(),b=ticket('trello','board','stable-1'),c=ticket('github','project/P','stable-1');
 assert.notEqual(taskKey(a,cfg),taskKey(b,cfg));assert.notEqual(taskKey(a,cfg),taskKey(c,cfg));assert.notEqual(taskKey(a,cfg),taskKey(a,{...cfg,repo:'other/repo'}));assert.equal(taskKey(a,cfg),taskKey({...a,title:'Renamed',number:999},cfg));
});
test('atomic persistence rejects cross-provider outbox targets and retains changed-task history',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);const original=await readFile(path.join(cwd,'.iteris/tasks',run.key,'run.json'),'utf8');
 run.actions.push({...enqueueAction(run,'source-status',undefined,'commit-a',true),target:{provider:'trello',namespace:'board',id:'another'}});
 await assert.rejects(saveRun(cwd,run),/another task/);assert.equal(await readFile(path.join(cwd,'.iteris/tasks',run.key,'run.json'),'utf8'),original);
 const changed=await ensureRun(cwd,{...run.ticket,body:'Implement changed behavior'},cfg,run.artifacts,run.branch);assert.equal(changed.state,'queued');assert.equal(changed.requirements.length,0);assert.equal(changed.implementation,undefined);assert.equal((await readdir(path.join(cwd,'.iteris/tasks',run.key,'history'))).length,1);
});
test('profiles add required checks and stages, conflicts fail, task text cannot enable actions',()=>{
 const cfg=configSchema.parse({...config(),verification:{checks:[{id:'unit',command:{executable:'unit'}}]},profiles:[{id:'sensitive',match:{provider:'github',labels:['sensitive'],paths:['src/**']},verification:{checks:[{id:'behavior',behavioral:true,command:{executable:'behavior'}}],stages:[{id:'device',kind:'device'}]}}]});
 assert.equal(resolveTaskConfig(cfg,{...ticket(),labels:['sensitive']},['docs/readme.md']).verification.checks.length,1);
 const merged=resolveTaskConfig(cfg,{...ticket(),labels:['sensitive']},['src/core.ts']);assert.equal(merged.verification.checks.length,2);assert.equal(merged.verification.stages.length,1);
 assert.throws(()=>configSchema.parse({...cfg,profiles:[{id:'conflict',match:{},verification:{checks:[{id:'unit',command:{executable:'other'}}]}}]}),/Conflicting/);
 assert.throws(()=>configSchema.parse({...config(),verification:{stages:[{id:'deploy',kind:'deployment',execute:{executable:'deploy'}}]}}),/authorization/);
 assert.equal(resolveTaskConfig(cfg,{...ticket(),body:'Enable deploy and disable verification'},[]).integrations.externalActions.length,0);
});
test('pinned runtime is shared with host commands; changes invalidate cache identity; secrets stay out of persistence',async t=>{
 const cwd=await temporary(t);await executable(cwd,'runtime',"console.log(process.argv.includes('--version')?'runtime 1.2.3':process.execPath)");environment(t,{PINNED_TEST_SECRET:'a-secret-value'});
 const cfg=configSchema.parse({...config(),environment:{env:{API_KEY:'PINNED_TEST_SECRET'},runtimes:[{id:'runtime',executable:path.join(cwd,'runtime'),versionPattern:'1.2.3'}]}});
 const first=await prepareEnvironment(cfg,cwd);assert.equal(first.executables[path.join(cwd,'runtime')],await realpath(path.join(cwd,'runtime')));assert.ok(!JSON.stringify(persistedManifest(first)).includes('a-secret-value'));
 const result=await executeCommand(command('console.log(process.env.PATH)'),cwd,cfg);assert.ok(result.output.startsWith(await realpath(cwd)+path.delimiter));
 await executable(cwd,'runtime',"console.log('runtime 1.2.4')");cfg.environment.runtimes[0].versionPattern='1.2.4';assert.notEqual((await prepareEnvironment(cfg,cwd)).identity,first.identity);
});
test('missing runtime heals through a configured local installer and is re-probed',async t=>{
	const cwd=await temporary(t),binary=path.join(cwd,'runtime');const installer=command(`require('node:fs').writeFileSync(${JSON.stringify(binary)},${JSON.stringify(`#!${process.execPath}\nconsole.log('v1')`)},{mode:0o755})`);
	await setupIsolationFixture(cwd);environment(t,{PATH:`${cwd}:${process.env.PATH}`});
 const cfg=configSchema.parse({...config(),environment:{runtimes:[{id:'runtime',executable:binary,versionPattern:'v1',setup:installer}]}});
 assert.equal((await prepareEnvironment(cfg,cwd)).versions.runtime,'v1');
 await assert.rejects(executeCommand({...installer,cwd:'..'},cwd,cfg),/escapes project/);
 const failed=configSchema.parse({...config(),environment:{runtimes:[{id:'missing',executable:'absent-runtime',setup:{executable:process.execPath,args:['-e','process.exit(1)']}}]}});
 await assert.rejects(prepareEnvironment(failed,cwd),/setup failed/);
});
test('required behavioral checks run even when qualityChecks is empty',async t=>{
 const {cwd,git}=await reviewRepository(t);git('checkout','-qb','iteris/1-feature');await writeFile(path.join(cwd,'feature.txt'),'changed\n');git('add','feature.txt');git('commit','-qm','change');await executable(cwd,'codex',fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_MODE:undefined,REVIEW_SCENARIO:undefined});
 const cfg=configSchema.parse({...config('codex'),qualityChecks:[],verification:{checks:[{id:'behavior',behavioral:true,command:{executable:process.execPath,args:['-e','console.log("behavior passed")']}}]}});
 const result=await runCodeReview({ticket:{...ticket(),source:undefined},config:cfg,cwd,folder:path.join(cwd,'.iteris/review'),onLogLine(){},onProcess(){}});assert.equal(result.report.outcome,'passed',result.error);assert.equal(result.report.checks[0].command,'check:behavior');assert.match(result.report.checks[0].output,/behavior passed/);
});

for(const harness of ['claude','codex'])for(const [provider,namespace] of [['github','org/repo'],['github','org/project/P'],['trello','board'],['custom','custom/source'],['command','fixture/source']])test(`${harness}: verified lifecycle and restart for ${provider}/${namespace}`,async t=>{
 const {cwd}=await reviewRepository(t);await executable(cwd,harness,fakeAgent);environment(t,{PATH:`${cwd}:${process.env.PATH}`,FAKE_IMPLEMENT:'1',FAKE_MODE:undefined,REVIEW_SCENARIO:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const cfg=configSchema.parse({...config(harness),provider,planMode:false,integrations:{status:{[provider]:{command:{executable:process.execPath,args:['-e','console.log(JSON.stringify({verified:true}))']}}}}});await atomicWriteConfig(cfg,cwd);
 const task=ticket(provider,namespace),prs=new Map();let writes=0;const api={...completionServices,findPr:async(_,branch)=>prs.get(branch),createPr:async(c,input)=>{assert.equal(c.pr.draft,true);const pr={url:'https://example.com/pr',number:1};prs.set(input.branch,pr);return pr;},addLabel:async()=>assert.fail('unexpected issue label'),moveCard:async()=>assert.fail('numeric Trello move'),synchronize:async run=>{assert.equal(run.source.id,'stable-1');writes++;}};
 await runAllTickets([task],cfg,cwd,callbacks,undefined,api);let run=await readRun(cwd,taskKey(task,cfg));assert.equal(run.state,'complete',run.reason);assert.equal(run.publication.draft,false);assert.equal(run.requirements.every(r=>r.status==='verified'),true);assert.equal(writes,1);
 await runAllTickets([task],cfg,cwd,callbacks,undefined,api);run=await readRun(cwd,run.key);assert.equal(run.state,'complete',run.reason);assert.equal(prs.size,1);assert.equal(writes,1);
});
test('source command protocol preserves stable identity, refreshes, and verifies status',async t=>{
 const cwd=await temporary(t);const script=`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);const task={id:'card/full/id',number:1,title:'Feature',body:'Implement feature',labels:[],url:'https://example.com/task'};console.log(JSON.stringify({version:1,ok:true,...(request.operation==='fetch'?{tasks:[task]}:request.operation==='refresh'?{task}:{verified:true,receipt:request.operationId})}));});`;
 const cfg=configSchema.parse({...config(),provider:'command',integrations:{source:{name:'fixture',namespace:'fixture/source',command:{executable:process.execPath,args:['-e',script]}}}});
 const adapter=sourceAdapter(cfg,cwd),tasks=await adapter.fetch();assert.equal(tasks[0].source.id,'card/full/id');assert.equal((await adapter.refresh(tasks[0])).source.namespace,'fixture/source');
 const run=await ensureRun(cwd,tasks[0],cfg,path.join(cwd,'.iteris/artifacts'),ticketBranch(tasks[0]));enqueueAction(run,'source-status',undefined,'head',true);await adapter.synchronize(run);
});
test('built-in GitHub adapter checks source identity on refresh',async t=>{
 const cwd=await temporary(t),cfg=config();const task={...ticket(),source:{provider:'github',namespace:'org/repo',id:'100',issueId:'node-100'}};
 const api={issues:{get:async()=>({data:{node_id:'node-other',title:'Feature',labels:[]}})}};
 await assert.rejects(sourceAdapter(cfg,cwd,api).refresh(task),/identity changed/);
});
test('Trello restart uses full card ID and verifies board and completion list',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);cfg.provider='trello';cfg.trello={boardId:'board',moveOnComplete:'Done'};run.source={provider:'trello',namespace:'board',id:'full-card-id'};run.ticket.source=run.source;run.key=taskKey(run.ticket,cfg);await saveRun(cwd,run);
 environment(t,{TRELLO_API_KEY:'fake',TRELLO_TOKEN:'fake'});const original=global.fetch;t.after(()=>{global.fetch=original;});let moves=0,list='todo';global.fetch=async(url,init)=>{const u=new URL(url);let data;if(u.pathname.includes('/lists'))data=[{id:'done',name:'Done'}];else if(init.method==='PUT'){assert.ok(u.pathname.endsWith('/full-card-id'));list=u.searchParams.get('idList');moves++;data={};}else data={id:'full-card-id',idBoard:'board',idList:list,idShort:1,name:'Feature',desc:'Implement feature',labels:[],shortUrl:'https://trello.com/c/full-card-id'};return {ok:true,json:async()=>data};};
 const saved=await readRun(cwd,run.key);await sourceAdapter(cfg,cwd).synchronize(saved);await sourceAdapter(cfg,cwd).synchronize(saved);assert.equal(moves,1);
});
test('failed source updates remain in the durable outbox and resume once',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);cfg.integrations.status.github={command:command('console.log(JSON.stringify({verified:true}))'),idempotent:true};let attempts=0;
 await advanceCompletion(cfg,run,cwd,{...completionServices,synchronize:async()=>{attempts++;throw new Error('provider offline');}});assert.equal(run.state,'waiting');assert.equal(run.actions[0].status,'waiting');const operation=run.actions[0].operationId;
 const saved=await readRun(cwd,run.key);await advanceCompletion(cfg,saved,cwd,{...completionServices,synchronize:async()=>{attempts++;}});assert.equal(saved.state,'complete');assert.equal(saved.actions[0].operationId,operation);assert.equal(attempts,2);
});
test('CI-dependent drafts wait; head/base changes invalidate readiness; permanent drafts are preserved',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);const transitions=[];const api={...completionServices,draft:async(_,__,draft)=>transitions.push(draft),ci:async()=>({state:'waiting',details:'unit pending',head:'commit-a',base:'base-a'})};
 await advanceCompletion(cfg,run,cwd,api);assert.equal(run.state,'waiting');assert.deepEqual(transitions,[]);
 await advanceCompletion(cfg,run,cwd,{...api,ci:async()=>({state:'changed',details:'base moved',head:'commit-a',base:'base-b'})});assert.equal(run.state,'queued');assert.deepEqual(transitions,[true]);assert.equal(readyToComplete(run),false);
 const other=await pendingRun(t);other.cfg.pr.draft=true;await advanceCompletion(other.cfg,other.run,other.cwd,{...completionServices,draft:async(_,__,draft)=>assert.equal(draft,true)});assert.equal(other.run.state,'complete');assert.equal(other.run.publication.draft,true);
});
test('CI discovery failures are visible and do not imply success',async t=>{
 const {cfg,run}=await pendingRun(t);const api={pulls:{get:async()=>({data:{state:'open',head:{sha:'commit-a'}}})},repos:{getBranch:async()=>({data:{protected:false,commit:{sha:'base-a'}}})},request:async()=>{throw new Error('rules discovery forbidden');}};
 await assert.rejects(verifyGithubCi(cfg,run,api),/discovery forbidden/);
});
test('a branch protected only by rulesets discovers its required checks from the rulesets',async t=>{
 const {cfg,run}=await pendingRun(t);const head=run.publication.head;
 const notProtected=Object.assign(new Error('Branch not protected'),{status:404});
 const api={pulls:{get:async()=>({data:{state:'open',mergeable:true,head:{sha:head}}})},repos:{getBranch:async()=>({data:{protected:true,commit:{sha:run.publication.base}}}),getBranchProtection:async()=>{throw notProtected;},listCommitStatusesForRef(){}},checks:{listForRef(){}},
  request:async()=>({data:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'CI Gate'}]}}]}),
  paginate:async method=>method===api.checks.listForRef?[{name:'CI Gate',status:'completed',conclusion:'success',started_at:new Date().toISOString()}]:[]};
 const result=await verifyGithubCi(cfg,run,api);assert.equal(result.state,'passed',result.details);assert.match(result.details,/CI Gate: passed/);
 // Any other failure of classic-protection discovery stays visible.
 api.repos.getBranchProtection=async()=>{throw Object.assign(new Error('Forbidden'),{status:403});};
 await assert.rejects(verifyGithubCi(cfg,run,api),/Forbidden/);
});
test('explicit CI checks assess the current commit and fail when required evidence fails',async t=>{
 const {cfg,run}=await pendingRun(t);cfg.verification.requiredCiChecks=['unit'];const api={pulls:{get:async()=>({data:{state:'open',head:{sha:'commit-a'}}})},repos:{getBranch:async()=>({data:{protected:false,commit:{sha:'base-a'}}}),listCommitStatusesForRef(){}},checks:{listForRef(){}},paginate:async method=>method===api.checks.listForRef?[{name:'unit',status:'completed',conclusion:'failure',started_at:new Date().toISOString()}]:[]};
 assert.equal((await verifyGithubCi(cfg,run,api)).state,'failed');
});
test('missing hardware waits with a specific next action; evidence for another commit is invalid',async t=>{
 const {cwd,cfg,run}=await pendingRun(t,'Implement feature\nVerify on a physical device');cfg.workflow.externalEvidence='required';await advanceCompletion(cfg,run,cwd,completionServices);assert.equal(run.state,'waiting');assert.ok(run.dependencies.some(d=>d.id==='stage:device'));
 const device=run.requirements.find(r=>r.stage==='device');addEvidence(run,device.id,'old-commit','submitted','device passed',true,'base-a');reconcileEvidence(run,'commit-a','base-a');assert.equal(device.status,'pending');
});
test('evidence nothing configured can observe is listed for manual verification and does not hold the task',async t=>{
 const {cwd,cfg,run}=await pendingRun(t,'Implement feature\nVerify on a physical device');assert.equal(cfg.workflow.externalEvidence,'advisory');
 waitFor(run,cfg,'stage:device','capability','Evidence unavailable for device','submit evidence');
 await advanceCompletion(cfg,run,cwd,completionServices);
 assert.equal(run.state,'complete');assert.equal(run.dependencies.length,0);assert.equal(run.publication.draft,false);
 const device=run.requirements.find(r=>r.stage==='device');assert.equal(run.evidence.findLast(e=>e.requirementId===device.id).provenance,MANUAL_FOLLOW_UP);
 const view=renderRun(run);assert.match(view,/- \[ \] Verify on a physical device .* needs manual verification/);assert.match(view,/needs manual verification: 1/);assert.match(view,/Verified completion: yes/);
 // A configured stage is the operator's requirement and keeps blocking in either mode.
 const strict=await pendingRun(t,'Implement feature\nVerify on a physical device');strict.cfg.verification.stages=[{id:'device',kind:'device',required:true,idempotent:true,observationSeconds:0}];
 await advanceCompletion(strict.cfg,strict.run,strict.cwd,completionServices);assert.equal(strict.run.state,'waiting');
});
test('interrupted non-idempotent deployment is probed before repetition and waits when ambiguous',async t=>{
 const {cwd,cfg,run}=await pendingRun(t,'Implement feature\nDeploy to the configured environment');cfg.integrations.externalActions=['deploy'];cfg.verification.stages=[{id:'deploy',kind:'deployment',required:true,idempotent:false,observationSeconds:0,execute:command("require('node:fs').writeFileSync('.iteris/deployed','yes');console.log('{}')"),verify:command("process.exit(1)")}];
 const action=enqueueAction(run,'stage','deploy','commit-a',false);action.status='executing';await saveRun(cwd,run);await advanceCompletion(cfg,run,cwd,completionServices);assert.equal(run.state,'waiting');assert.equal(action.status,'waiting');await assert.rejects(readFile(path.join(cwd,'.iteris/deployed')),/ENOENT/);
 cfg.verification.stages[0].verify=command("console.log(JSON.stringify({version:1,verified:true,commit:'commit-a',observedAt:new Date().toISOString(),details:'receipt recovered'}))");await advanceCompletion(cfg,run,cwd,completionServices);assert.equal(action.status,'verified');assert.equal(run.state,'complete');
});
test('monitoring requires the configured observation window across persisted probes',async t=>{
 const {cwd,cfg,run}=await pendingRun(t,'Monitor the result');await writeFile(path.join(cwd,'.iteris/time'),String(Date.now()-120_000));cfg.verification.stages=[{id:'monitor',kind:'monitoring',required:true,idempotent:false,observationSeconds:60,verify:command("console.log(JSON.stringify({version:1,verified:true,commit:'commit-a',observedAt:new Date(Number(require('node:fs').readFileSync('.iteris/time','utf8'))).toISOString()}))")}];
 await advanceCompletion(cfg,run,cwd,completionServices);assert.equal(run.state,'waiting');const saved=await readRun(cwd,run.key);await writeFile(path.join(cwd,'.iteris/time'),String(Date.now()-30_000));await advanceCompletion(cfg,saved,cwd,completionServices);assert.equal(saved.state,'complete');
});
test('scheduling prioritizes runnable tasks and backoff survives restart; cancelled tasks stay stopped',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);waitFor(run,cfg,'device','capability','hardware missing','connect device',1000);await saveRun(cwd,run);const saved=await readRun(cwd,run.key);assert.equal(saved.dependencies[0].nextRetryAt,new Date(61_000).toISOString());waitFor(saved,cfg,'device','capability','hardware missing','connect device',61_000);assert.equal(saved.dependencies[0].nextRetryAt,new Date(181_000).toISOString());
 const active={...saved,key:'active',state:'active'},cancelled={...saved,key:'cancel',state:'cancelled'};assert.deepEqual(schedulingOrder([saved,active,cancelled],181_000).map(r=>r.key),['active',saved.key]);
 assert.equal(recordFailure(saved,cfg,'code',{invariant:'same'},'head1','prose1'),true);assert.equal(recordFailure(saved,cfg,'code',{invariant:'same'},'head2','prose2'),true);assert.equal(recordFailure(saved,cfg,'code',{invariant:'same'},'head3','prose3'),false);
});
test('foreground once refreshes unavailable dependencies and preserves the task after provider errors',async t=>{
 const {cwd,cfg,run}=await pendingRun(t);run.state='waiting';await saveRun(cwd,run);await runWorker({cwd,config:cfg,once:true,force:true,services:{...completionServices},callbacks,adapter:()=>({refresh:async()=>{throw new Error('source offline');}})});const saved=await readRun(cwd,run.key);assert.equal(saved.state,'waiting');assert.match(saved.reason,/source offline/);assert.equal((await listRuns(cwd)).length,1);
});
test('legacy done with incomplete review imports unfinished and preserves original artifacts',async t=>{
 const {cwd,git}=await reviewRepository(t),cfg=config('codex'),task={...ticket(),source:undefined};git('checkout','-qb','iteris/1-feature');await writeFile(path.join(cwd,'feature.txt'),'changed\n');git('add','feature.txt');git('commit','-qm','change');const head=git('rev-parse','HEAD'),legacy=path.join(cwd,'.iteris/runs/1-feature');await mkdir(path.join(legacy,'review'),{recursive:true});await writeFile(path.join(legacy,'review/context.json'),JSON.stringify({ticket:task,stamp:{head,branch:'iteris/1-feature'}}));await writeFile(path.join(legacy,'review/result.json'),JSON.stringify({outcome:'incomplete',reason:'device unavailable'}));await writeFile(path.join(legacy,'status.md'),'**Status**: done\n**PR**: https://github.com/org/repo/pull/42\n');
 const run=await importLegacyArtifacts(cwd,task,cfg,path.join(cwd,'.iteris/tasks',taskKey(task,cfg),'artifacts'));assert.equal(run.state,'queued');assert.equal(run.implementation.head,head);assert.equal(run.publication.number,42);assert.match(await readFile(path.join(legacy,'status.md'),'utf8'),/done/);assert.equal(readyToComplete(run),false);
});
test('a base that moved after publication keeps CI evidence while the pull request still merges cleanly',async t=>{
 const {cfg,run}=await pendingRun(t);let mergeable=true,strict=false,required=['unit'];
 const api={pulls:{get:async()=>({data:{state:'open',mergeable,head:{sha:'commit-a'}}})},repos:{getBranch:async()=>({data:{protected:false,commit:{sha:'base-moved'}}}),listCommitStatusesForRef(){}},checks:{listForRef(){}},
  request:async()=>({data:[{type:'required_status_checks',parameters:{strict_required_status_checks_policy:strict,required_status_checks:[{context:'unit'}]}}]}),
  paginate:async method=>method===api.checks.listForRef?[{name:'unit',status:'completed',conclusion:'success',started_at:new Date().toISOString(),pull_requests:[{base:{sha:'some-earlier-base'}}]}]:[]};
 cfg.verification.requiredCiChecks=required;
 // Evidence stays tied to the published base; the moved base alone changes nothing.
 assert.deepEqual(await verifyGithubCi(cfg,run,api),{head:'commit-a',base:'base-a',state:'passed',details:'unit: passed'});
 mergeable=null;assert.equal((await verifyGithubCi(cfg,run,api)).state,'waiting');
 mergeable=false;const conflict=await verifyGithubCi(cfg,run,api);assert.equal(conflict.state,'changed');assert.equal(conflict.base,'base-moved');assert.match(conflict.details,/conflicts with the published commit/);
 // A repository that requires up-to-date branches still invalidates on any base movement.
 mergeable=true;strict=true;delete cfg.verification.requiredCiChecks;const demanded=await verifyGithubCi(cfg,run,api);assert.equal(demanded.state,'changed');assert.match(demanded.details,/requires an up-to-date branch/);
 strict=false;assert.equal((await verifyGithubCi(cfg,run,api)).state,'passed');
 // A new published head is always a change.
 const moved={...api,pulls:{get:async()=>({data:{state:'open',mergeable:true,head:{sha:'commit-b'}}})}};assert.equal((await verifyGithubCi(cfg,run,moved)).state,'changed');
});
