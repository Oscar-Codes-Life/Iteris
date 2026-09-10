import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {configSchema} from '../dist/config.js';
export const config = (harness = 'claude') => configSchema.parse({version: 2, repo: 'org/repo', harness, harnesses: {claude: {model: 'opus', effort: 'xhigh', flags: ['--dangerously-skip-permissions']}, codex: {model: 'test-model', effort: 'high', flags: []}}, setupComplete: true});
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
 process.stdin.on('end', () => {
  if (process.env.CAPTURE) fs.appendFileSync(process.env.CAPTURE,JSON.stringify({harness,args,prompt})+'\\n');
  const mode=process.env.FAKE_MODE;
  if(mode==='hang') {setInterval(()=>{},1000); return;}
  const text=prompt.startsWith('Inspect this task')?'Implementation plan':prompt.startsWith('Write a high-value pull request description')?'## Summary\\n- Adds useful behavior.\\n\\n## Changes\\n- Updates the implementation.\\n\\n## Validation\\n- Tests passed.':prompt.startsWith('You are summarizing')?'Session summary':'<task>done</task>';
  let event=harness==='codex'?{type:'item.completed',item:{type:'agent_message',text}}:{type:'assistant',message:{content:[{type:'text',text}]}};
  if(mode==='tool') event=harness==='codex'?{type:'item.completed',item:{type:'command_execution',aggregated_output:'<task>done</task>'}}:{type:'user',message:{content:[{type:'tool_result',content:'<task>done</task>'}]}};
  const output=mode==='malformed'?'not json':JSON.stringify(event);
  process.stdout.write(output.slice(0,7));
  setTimeout(()=>{process.stdout.write(output.slice(7)); if(mode==='fail')process.exitCode=2;},5);
 });
}
`;
