import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {configSchema} from '../dist/config.js';
export const config = (harness = 'claude') => configSchema.parse({version: 2, repo: 'org/repo', harness, harnesses: {claude: {model: 'opus', effort: 'xhigh', flags: ['--dangerously-skip-permissions']}, codex: {model: 'test-model', effort: 'high', flags: []}}, setupComplete: true, qualityChecks: ['true']});
export async function temporary(t) {
 const folder = await mkdtemp(path.join(os.tmpdir(), 'iteris-test-'));
 t.after(() => rm(folder, {recursive:true, force:true})); return folder;
}
export function environment(t, values) {
 const original = {...process.env};
 for (const [key, value] of Object.entries(values)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
 t.after(() => {for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);});
}
export async function executable(folder, name, script) {await writeFile(path.join(folder,name), `#!${process.execPath}\n${script}`, {mode:0o755});}
export const fakeAgent = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const harness = path.basename(process.argv[1]);
if (args[0] === 'app-server') {
 const input = readline.createInterface({input:process.stdin});
 input.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'initialize') {console.log(JSON.stringify({id:request.id,result:{}})); return;}
  const next = request.params.cursor;
  console.log(JSON.stringify({id:request.id,result:{data:[{model:next?'second-model':'test-model',displayName:'Test',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:!next}],nextCursor:next?null:'page2'}}));
 });
} else {
 let prompt=''; process.stdin.on('data', chunk => prompt+=chunk);
 process.stdin.on('end', async () => {
  if (process.env.CAPTURE) fs.appendFileSync(process.env.CAPTURE,JSON.stringify({harness,args,prompt})+'\\n');
  const reviewPhase = prompt.startsWith('ITERIS_REVIEW') ? prompt.split('\\n')[0].split(' ')[1] : prompt.split('\\n')[0];
  if (process.env.REVIEW_HANG_PHASE === reviewPhase) {setInterval(()=>{},1000); return;}
  if (process.env.REVIEW_WAIT_FOR_RISK === '1' && ['correctness','maintainability'].includes(reviewPhase)) {
   while (!fs.readFileSync(process.env.CAPTURE,'utf8').includes('ITERIS_REVIEW risk')) await new Promise(resolve=>setTimeout(resolve,10));
  }
  const delay = JSON.parse(process.env.REVIEW_DELAYS || '{}')[reviewPhase];
  if (delay) await new Promise(resolve=>setTimeout(resolve,delay));
  const mode=process.env.FAKE_MODE;
  if(mode==='hang') {setInterval(()=>{},1000); return;}
  if (process.env.FAKE_IMPLEMENT === '1' && prompt.startsWith('You are an autonomous') && mode !== 'fail') {
   const git=(...args)=>require('node:child_process').execFileSync('git',args,{stdio:'pipe'});
   const branch=prompt.match(/otherwise create it: \`([^\`]+)\`/)[1];
   try {git('checkout',branch);} catch {git('checkout','-b',branch,'main');}
   fs.writeFileSync('feature.txt','implemented '+branch+'\\n');git('add','feature.txt');
   git('commit','--allow-empty','-qm','implement');
  }
  let text=prompt.startsWith('Inspect this task')?'Implementation plan':prompt.startsWith('Write a high-value pull request description')?'## Summary\\n- Adds useful behavior.\\n\\n## Changes\\n- Updates the implementation.':prompt.startsWith('You are summarizing')?'Session summary':'<task>done</task>';
  if (prompt.startsWith('ITERIS_REVIEW')) {
   const input=JSON.parse(prompt.split('INPUT_JSON\\n')[1]);
   const context=input.context, scenario=process.env.REVIEW_SCENARIO;
   const requirement={requirement:'Implement feature',status:scenario==='missing'?'missing':scenario==='unverified'?'unverified':'covered',evidence:'feature.txt implements the requested behavior'};
   const broken=context.diff.includes('+broken');
   const needsEvidence=['recover-evidence','recover-verifier','recover-unverified','recover-with-blocker','recover-failed-check','external-gap'].includes(scenario) && !input.checks.some(c=>c.command==='printf recovery-evidence' && c.exitCode===0);
   if(['recover-unverified','recover-with-blocker'].includes(scenario) && needsEvidence) requirement.status='unverified';
   const finding={category:'correctness',priority:scenario==='advisory'?'medium':'high',file:'feature.txt',line:1,side:'new',title:scenario==='moving-blocker'?context.stamp.head:'Broken behavior',trigger:'Call feature',expected:'fixed',actual:'broken',impact:'Wrong result',evidence:'feature.txt returns broken',remedy:'Return fixed',materialRegression:false,policyRule:''};
   if (scenario==='invalid-location') finding.line = 99999;
   if (prompt.startsWith('ITERIS_REVIEW verify')) {
    text=JSON.stringify({head:context.stamp.head,complete:!(scenario==='recover-verifier' && needsEvidence),gaps:scenario==='recover-verifier' && needsEvidence?['Recovery tests were not run']:[],requirements:[requirement],decisions:scenario==='omit-decision'?[]:input.candidates.map(f=>({id:f.id,status:scenario==='false-positive'?'rejected':'confirmed',evidence:'Independent causal trace'})),resolved:scenario==='missing-resolution'?[]:input.previousBlockers.filter(f=>!input.candidates.some(c=>c.id===f.id)).map(f=>({id:f.id,evidence:'feature.txt now returns fixed'}))});
   } else {
    text=JSON.stringify({head:scenario==='wrong-head'?'wrong':context.stamp.head,complete:scenario!=='incomplete' && !(needsEvidence && !['recover-verifier','recover-unverified','recover-with-blocker'].includes(scenario)),inspectedFiles:scenario==='omit-file'?[]:context.changedFiles,gaps:needsEvidence && !['recover-verifier','recover-unverified','recover-with-blocker'].includes(scenario)?['Recovery tests were not run']:[],requirements:prompt.startsWith('ITERIS_REVIEW correctness')?[requirement]:[],findings:['blocker','moving-blocker','false-positive','advisory','omit-decision'].includes(scenario)||broken?[finding]:[]});
   }
   if (scenario==='malformed') text='<task>done</task>';
  }
  if (prompt.startsWith('ITERIS_RECOVER')) {
   if (process.env.REVIEW_SCENARIO==='recover-with-blocker') {
    const git=(...args)=>require('node:child_process').execFileSync('git',args,{stdio:'pipe'});
    fs.writeFileSync('feature.txt','fixed\\n');git('add','feature.txt');git('commit','-qm','recover');
   }
   text=JSON.stringify({checks:[process.env.REVIEW_SCENARIO==='recover-failed-check'?'exit 9':'printf recovery-evidence'],blockedReason:process.env.REVIEW_SCENARIO==='external-gap'?'Hosted credentials unavailable':''});
  }
  if (prompt.startsWith('ITERIS_REPAIR') && process.env.REVIEW_SCENARIO!=='no-repair') {
   const git=(...args)=>require('node:child_process').execFileSync('git',args,{stdio:'pipe'});
   fs.writeFileSync('feature.txt','fixed\\n');git('add','feature.txt');git('commit','--allow-empty','-qm','repair');
  }
  let event=harness==='codex'?{type:'item.completed',item:{type:'agent_message',text}}:{type:'assistant',message:{content:[{type:'text',text}]}};
  if(mode==='tool') event=harness==='codex'?{type:'item.completed',item:{type:'command_execution',aggregated_output:'<task>done</task>'}}:{type:'user',message:{content:[{type:'tool_result',content:'<task>done</task>'}]}};
  const output=mode==='malformed'?'not json':JSON.stringify(event);
  process.stdout.write(output.slice(0,7));
  setTimeout(()=>{process.stdout.write(output.slice(7)); if(mode==='fail' || process.env.REVIEW_FAIL_PHASE === reviewPhase)process.exitCode=2;},5);
 });
}
`;

export async function reviewRepository(t, existing) {
 const cwd = existing ?? await temporary(t);
 const remote = await temporary(t);
 const git = (...args) => execFileSync('git', args, {cwd, stdio:'pipe', encoding:'utf8'}).trim();
 git('init', '-q', '-b', 'main');
 git('config','user.email','test@example.com'); git('config','user.name','Test');
 await writeFile(path.join(cwd,'.git/info/exclude'), '\n.iteris/\n.tasks/\n.iteris.json\ncalls.jsonl\nclaude\ncodex\n');
 await writeFile(path.join(cwd,'feature.txt'), 'base\n'); git('add','feature.txt'); git('commit','-qm','base');
 execFileSync('git',['init','--bare','-q',remote]); git('remote','add','origin',remote); git('push','-q','origin','main');
 return {cwd, remote, git};
}
