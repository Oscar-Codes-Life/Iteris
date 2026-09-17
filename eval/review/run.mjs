import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cases} from './cases.mjs';
import {runCodeReview} from '../../dist/agent/reviewer.js';
import {configSchema} from '../../dist/config.js';
const args=process.argv.slice(2);
const value=flag=>args[args.indexOf(flag)+1];
if(!args.includes('--case')&&!args.includes('--all')) {
 console.log('Runs real local review agents; consumes your selected provider usage.\nUsage: npm run eval:review -- --case zero-default --harness codex [--model ID] [--out DIR]\nUse --all to explicitly run all 30 synthetic cases.\n\n'+cases.map(c=>`${c.id}: ${c.kind}`).join('\n'));
 process.exit(0);
}
const harness=args.includes('--harness')?value('--harness'):'codex';
if(!['claude','codex'].includes(harness))throw new Error('Harness must be claude or codex.');
const selected=args.includes('--all')?cases:cases.filter(c=>c.id===value('--case'));
if(!selected.length)throw new Error('Unknown case. Run without arguments to list cases.');
const out=path.resolve(args.includes('--out')?value('--out'):`.iteris/evaluations/${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(out,{recursive:true});
const results=[];
const controller=new AbortController();process.on('SIGINT',()=>controller.abort());process.on('SIGTERM',()=>controller.abort());
for(const item of selected) {
 if(controller.signal.aborted)break;
 const cwd=await mkdtemp(path.join(tmpdir(),'iteris-eval-'));
 const git=(...argv)=>execFileSync('git',argv,{cwd,stdio:'pipe'});
 try {
  git('init','-q','-b','main');git('config','user.name','Iteris evaluation');git('config','user.email','eval@example.invalid');
  await writeFile(path.join(cwd,'feature.mjs'),item.before+'\n');git('add','.');git('commit','-qm','base');git('checkout','-qb','iteris/1-evaluation');
  await writeFile(path.join(cwd,'feature.mjs'),item.after+'\n');git('add','.');git('commit','-qm','candidate');
  const config=configSchema.parse({version:2,repo:'local/evaluation',harness,harnesses:{[harness]:{model:args.includes('--model')?value('--model'):undefined}},qualityChecks:[`'${process.execPath.replaceAll("'","'\\''")}' --check feature.mjs`],review:{maxRepairCycles:0}});
  console.log(`Reviewing ${item.id}`);
  const result=await runCodeReview({ticket:{number:1,title:item.id,body:item.requirement,slug:'evaluation',labels:[],htmlUrl:''},config,cwd,folder:path.join(out,item.id),audit:true,signal:controller.signal,onProcess(){},onLogLine:line=>console.log(line)});
  results.push({id:item.id,kind:item.kind,expected:item.expected,outcome:result.report.outcome,durationMs:Date.parse(result.report.finishedAt)-Date.parse(result.report.startedAt),head:result.report.stamp?.head,findings:result.report.findings,human:{validFindings:[],invalidFindings:[],missedDefects:[],falseBlock:null,notes:''}});
 } finally {await rm(cwd,{recursive:true,force:true});}
 await writeFile(path.join(out,'adjudications.json'),JSON.stringify(results,null,2)+'\n');
}
console.log(`Evidence and blank human adjudications: ${out}`);
