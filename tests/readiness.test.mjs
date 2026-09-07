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
test('waits for Codex update, verifies version, caches readiness within batch',async t=>{
 const cwd=await fixture(t);await executable(cwd,'codex',fake);await ensureHarness('codex',{onStatus(){}});
 assert.equal(await readFile(process.env.FINISHED,'utf8'),'yes');
 const calls=(await readFile(process.env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(args=>args[0]==='--version').length,2);const before=calls.length;
 await ensureHarness('codex');assert.equal((await readFile(process.env.CALLS,'utf8')).trim().split('\n').length,before);
});
test('failed update offers explicit continuation only for compatible CLI',async t=>{
 const cwd=await fixture(t,{UPDATE_FAIL:'1'});await executable(cwd,'codex',fake);
 await assert.rejects(ensureHarness('codex',{onStatus(){}}),error=>error instanceof ReadinessError && error.canContinue);
 await ensureHarness('codex',{skipUpdate:true,onStatus(){}});
 resetReadiness();process.env.INCOMPATIBLE='1';await assert.rejects(ensureHarness('codex',{onStatus(){}}),error=>!error.canContinue);
});
test('login failure blocks continuation',async t=>{
 const cwd=await fixture(t,{LOGIN_FAIL:'1'});await executable(cwd,'codex',fake);
 await assert.rejects(ensureHarness('codex',{skipUpdate:true,onStatus(){}}),/login did not complete/);
});
test('missing Claude provides instructions; missing Codex waits for installer and rechecks PATH',async t=>{
 const cwd=await fixture(t);await assert.rejects(ensureHarness('claude'),/Claude Code is missing/);
 // A fake shell stands in for the official installer; no downloads occur.
 const source=`#!${process.execPath}\n${fake}`;
 await executable(cwd,'sh',`require('node:fs').writeFileSync(${JSON.stringify(path.join(cwd,'codex'))},${JSON.stringify(source)},{mode:0o755});`);
 await ensureHarness('codex',{onStatus(){}});assert.equal(await readFile(process.env.FINISHED,'utf8'),'yes');
});
test('failed installer and unknown old installation manager do not silently proceed',async t=>{
 const cwd=await fixture(t);await executable(cwd,'sh','process.exitCode=1;');
 await assert.rejects(ensureHarness('codex',{onStatus(){}}),/installation failed/);
 await executable(cwd,'codex',fake);process.env.OLDER='1';
 await assert.rejects(ensureHarness('codex',{onStatus(){}}),error=>error.canContinue && /installation manager/.test(error.message));
});
test('GitHub credentials use environment precedence then gh, and require gh',async t=>{
 const cwd=await temporary(t);environment(t,{PATH:cwd,GH_TOKEN:'first-token',GITHUB_TOKEN:'second-token'});
 assert.equal(resolveGithubToken(),'first-token');await assert.rejects(ensureGithubAuth(),/GitHub CLI/);
 delete process.env.GH_TOKEN;assert.equal(resolveGithubToken(),'second-token');delete process.env.GITHUB_TOKEN;
 await executable(cwd,'gh',`if(process.argv.includes('token'))console.log('stored-token');`);
 assert.equal(resolveGithubToken(),'stored-token');await ensureGithubAuth();
});
