import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ensureHarness, resetReadiness, ReadinessError} from '../dist/harness/readiness.js';
import {ensureGithubAuth, resolveGithubToken} from '../dist/github/auth.js';
import {temporary,environment,executable} from './helpers.mjs';
const fake = `
 const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
 if(args[0]==='--version')console.log('codex-cli 0.153.4');
 else if(args[0]==='update' && args.includes('--help')) process.exitCode=process.env.OLDER?1:0;
 else if(args[0]==='update') {setTimeout(()=>{fs.writeFileSync(process.env.FINISHED,'yes');process.exitCode=process.env.UPDATE_FAIL?1:0;},40);}
 else if(args[0]==='exec') {console.log(process.env.INCOMPATIBLE?'old':'--json --model --sandbox --dangerously-bypass-approvals-and-sandbox');}
 else if(args[0]==='login' || args[0]==='auth') {process.exitCode=process.env.LOGIN_FAIL?1:0;}
`;
async function fixture(t,extra={}) {const cwd=await temporary(t);environment(t,{PATH:cwd,CALLS:path.join(cwd,'calls'),FINISHED:path.join(cwd,'finished'),UPDATE_FAIL:undefined,INCOMPATIBLE:undefined,OLDER:undefined,LOGIN_FAIL:undefined,...extra});resetReadiness();return cwd;}
test('uses installed compatible Codex and never updates global tools',async t=>{
 const cwd=await fixture(t);await executable(cwd,'codex',fake);await ensureHarness('codex',{onStatus(){}});
 const calls=(await readFile(process.env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.some(args=>args[0]==='update'),false);const before=calls.length;
 await ensureHarness('codex');assert.equal((await readFile(process.env.CALLS,'utf8')).trim().split('\n').length,before);
});
test('incompatible installed CLI is actionable and never updated automatically',async t=>{
 const cwd=await fixture(t,{INCOMPATIBLE:'1'});await executable(cwd,'codex',fake);
 await assert.rejects(ensureHarness('codex',{onStatus(){}}),error=>error instanceof ReadinessError && !error.canContinue);
 const calls=(await readFile(process.env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(args=>args[0]==='update'),false);
});
test('login failure blocks continuation',async t=>{
 const cwd=await fixture(t,{LOGIN_FAIL:'1'});await executable(cwd,'codex',fake);
 await assert.rejects(ensureHarness('codex',{skipUpdate:true,onStatus(){}}),/login did not complete/);
});
test('missing harnesses require project-local setup or manual installation',async t=>{
 const cwd=await fixture(t);await executable(cwd,'sh',"require('node:fs').writeFileSync('installer-called','bad');");
 await assert.rejects(ensureHarness('claude'),/Claude Code is missing/);
 await assert.rejects(ensureHarness('codex'),/project-local installer/);
 await assert.rejects(readFile(path.join(cwd,'installer-called')),/ENOENT/);
});
test('GitHub credentials use environment precedence then gh, and require gh',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd,GH_TOKEN:'first-token',GITHUB_TOKEN:'second-token'});
 assert.equal(resolveGithubToken(),'first-token');await assert.rejects(ensureGithubAuth(),/GitHub CLI/);
 delete process.env.GH_TOKEN;assert.equal(resolveGithubToken(),'second-token');delete process.env.GITHUB_TOKEN;
 await executable(cwd,'gh',`if(process.argv.includes('token'))console.log('stored-token');`);
 assert.equal(resolveGithubToken(),'stored-token');await ensureGithubAuth();
});
