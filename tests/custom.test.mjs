import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {identifyItems, canonical} from '../dist/custom/identity.js';
import {download} from '../dist/custom/http.js';
import {importCustom, customStatuses, timestamp} from '../dist/custom/import.js';
import {invocation, runHarness} from '../dist/harness/process.js';
import {configSchema, atomicWriteConfig} from '../dist/config.js';
import {createRunFolder, writeStatus} from '../dist/state/manager.js';
import {ticketBranch} from '../dist/types.js';
import {runAllTickets} from '../dist/agent/runner.js';
import {temporary, environment, executable, config, fakeAgent} from './helpers.mjs';
const custom = {endpoint:'https://api.example.com/tasks', apiKeyEnv:'CUSTOM_TEST_KEY', itemsPath:''};
const cfg = (harness='codex') => ({...config(harness),provider:'custom',custom});
const ok = value => ({success:true,text:JSON.stringify(value),done:false,timedOut:false});
const draft = {title:'Fix navigation',description:'Repair the menu',labels:['p1'],analysis:'',attachments:[]};
async function fixture(t) {
 const cwd=await temporary(t); execFileSync('git',['init','-q',cwd]);
 environment(t,{CUSTOM_TEST_KEY:'test-custom-secret'});
 return cwd;
}
const importer = items => ({fetcher:async()=>Response.json(items),harness:async()=>ok(draft)});
test('custom config validates URLs, environment names and defaults',()=>{
 const c=configSchema.parse({...config(),provider:'custom',custom:{endpoint:custom.endpoint}});
 assert.equal(c.custom.apiKeyEnv,'CUSTOM_API_KEY'); assert.equal(c.custom.itemsPath,'');
 for(const endpoint of ['file:///etc/passwd','https://user:pass@example.com']) assert.equal(configSchema.safeParse({...c,custom:{endpoint}}).success,false);
 assert.equal(configSchema.safeParse({...c,custom:{...custom,apiKeyEnv:'bad-name'}}).success,false);
});
test('mixed identities support id/key, zero, numeric strings, custom paths and fingerprints',()=>{
 const identity = item => identifyItems([item],custom).items[0].identity;
 assert.equal(identity({id:0,title:'one'}),identity({id:'0',title:'two'}));
 assert.equal(identity({id:'',key:'a'}),identity({key:'a'}));
 assert.equal(identity({title:'one',nested:{b:2,a:1}}),identity({nested:{a:1,b:2},title:'one'}));
 assert.notEqual(identity({title:'one'}),identity({title:'two'}));
 assert.notEqual(identity({title:'one'}),identity({id:1,title:'one'}));
 assert.notEqual(identity({id:1}),identifyItems([{id:1}],{...custom,endpoint:'https://other.example/tasks'}).items[0].identity);
 assert.equal(identifyItems([{meta:{key:'x'},title:'one'}],{...custom,idPath:'meta.key'}).items[0].identity,identifyItems([{meta:{key:'x'},title:'two'}],{...custom,idPath:'meta.key'}).items[0].identity);
 assert.notEqual(canonical([1,2]),canonical([2,1]));
 assert.equal(identifyItems([{id:1},{id:1},{title:'a'}],custom).duplicates,1);
 assert.throws(()=>identifyItems([{id:1,title:'a'},{id:'1',title:'b'}],custom),/conflicting/);
});
test('HTTP rejects endpoint redirects, status failures and oversized streamed bodies',async()=>{
 const opts={endpoint:custom.endpoint,token:'secret'};
 await assert.rejects(download(custom.endpoint,{...opts,fetcher:async()=>new Response(null,{status:302,headers:{location:'/other'}})}),/redirects/);
 await assert.rejects(download(custom.endpoint,{...opts,fetcher:async()=>new Response('secret',{status:401})}),/^Error: HTTP 401$/);
 await assert.rejects(download(custom.endpoint,{...opts,maxBytes:2,fetcher:async()=>new Response('123')}),/size limit/);
 await assert.rejects(download(custom.endpoint,{...opts,maxBytes:2,fetcher:async()=>new Response('1',{headers:{'content-length':'3'}})}),/size limit/);
});
test('attachment redirects recompute bearer auth for every origin',async()=>{
 const calls=[];
 await download('https://api.example.com/file',{endpoint:custom.endpoint,token:'secret',attachment:true,fetcher:async(url,options)=>{
  calls.push([url,options.headers.Authorization]);
  return calls.length===1?new Response(null,{status:302,headers:{location:'https://files.example.com/image.png'}}):new Response('data');
 }});
 assert.equal(calls[0][1],'Bearer secret');assert.equal(calls[1][1],undefined);
});
test('import saves Markdown and manifest, preserves numbers and avoids timestamp collisions',async t=>{
 const cwd=await fixture(t);const services={...importer([{id:1},{title:'no id'}]),now:()=>new Date('2026-09-09T10:20:30.123Z')};
 const first=await importCustom(cfg(),cwd,services);const second=await importCustom(cfg(),cwd,services);
 assert.equal(first.tickets.length,2);assert.notEqual(first.directory,second.directory);
 assert.deepEqual(first.tickets.map(t=>t.number),second.tickets.map(t=>t.number));
 assert.equal(ticketBranch(first.tickets[0]),ticketBranch(second.tickets[0]));
 assert.match(await readFile(path.join(first.directory,'task1.md'),'utf8'),/Fix navigation/);
 assert.equal(JSON.parse(await readFile(path.join(first.directory,'manifest.json'),'utf8')).tasks.length,2);
 assert.match(await readFile(path.join(cwd,'.git/info/exclude'),'utf8'),/\.tasks/);
 assert.equal((await readdir(path.join(cwd,'.tasks'))).some(name=>name.startsWith('.import-')),false);
});
test('imports nested arrays and treats empty arrays as successful',async t=>{
 const cwd=await fixture(t);
 const result=await importCustom({...cfg(),custom:{...custom,itemsPath:'data.items'}},cwd,importer({data:{items:[{id:'x'}]}}));
 assert.equal(result.tickets.length,1);
 assert.deepEqual(await importCustom(cfg(),cwd,importer([])),{tickets:[],duplicates:0});
 await assert.rejects(importCustom(cfg(),cwd,importer({items:[]})),/array/);
 await assert.rejects(importCustom(cfg(),cwd,{fetcher:async()=>new Response('broken')}),/invalid JSON/);
});
test('validation retry succeeds, exhaustion publishes nothing, cancellation releases lock',async t=>{
 const cwd=await fixture(t);let attempts=0;
 const imported=await importCustom(cfg(),cwd,{...importer([{}]),harness:async()=>++attempts===1?ok({}):ok(draft)});
 assert.equal(attempts,2);
 await assert.rejects(importCustom(cfg(),cwd,{...importer([{}]),harness:async()=>ok({})}),/two attempts/);
 assert.deepEqual(await readdir(path.join(cwd,'.tasks')),[path.basename(imported.directory)]);
 const controller=new AbortController(); controller.abort();
 await assert.rejects(importCustom(cfg(),cwd,importer([{}]),controller.signal));
 assert.equal((await readdir(path.join(cwd,'.iteris'))).includes('active.json'),false);
});
test('downloads text and images, warns on unsupported and failed attachments',async t=>{
 const cwd=await fixture(t);const calls=[];
 const items=[{id:1,files:['https://api.example.com/a.txt','https://cdn.example.com/a.png','https://cdn.example.com/a.pdf','https://cdn.example.com/missing']}];
 const imported=await importCustom(cfg(),cwd,{fetcher:async(url,options)=>{
  if(url===custom.endpoint)return Response.json(items);
  assert.equal(options.headers.Authorization,url.startsWith('https://api.example.com')?'Bearer test-custom-secret':undefined);
  if(url.endsWith('.txt'))return new Response('Attachment text',{headers:{'content-type':'text/plain'}});
  if(url.endsWith('.png'))return new Response(Buffer.from('89504e470d0a1a0a','hex'),{headers:{'content-type':'image/png'}});
  if(url.endsWith('.pdf'))return new Response('pdf',{headers:{'content-type':'application/pdf'}});
  return new Response(null,{status:404});
 },harness:async options=>{calls.push(options);return calls.length===1?ok({...draft,attachments:items[0].files.map((_,i)=>({path:['files',i]}))}):ok({...draft,analysis:'Analyzed text and image.'});}});
 assert.equal(calls.length,2);assert.equal(calls[1].images.length,1);assert.match(calls[1].prompt,/Attachment text/);
 const manifest=JSON.parse(await readFile(path.join(imported.directory,'manifest.json'),'utf8'));
 const attachments=manifest.tasks[0].attachments;
 assert.equal(attachments.filter(a=>a.file).length,2);assert.match(attachments[2].warning,/Unsupported/);assert.match(attachments[3].warning,/404/);
 assert.match(await readFile(path.join(imported.directory,'task1.md'),'utf8'),/Analyzed text and image/);
});
test('completion identity is isolated and changed ID-based tasks retain history',async t=>{
 const cwd=await fixture(t);const first=await importCustom(cfg(),cwd,importer([{id:1,title:'old'}]));const ticket=first.tickets[0];
 const folder=await createRunFolder(cwd,ticket);
 await writeStatus(folder,{ticket,status:'done',branch:ticketBranch(ticket),logLines:[],elapsedMs:0});
 const same=await importCustom(cfg(),cwd,importer([{id:1,title:'old'}]));
 assert.equal((await customStatuses(cwd,same.tickets)).get(ticket.number),'done');assert.equal(same.tickets[0].custom.changed,false);
 const changed=await importCustom(cfg(),cwd,importer([{id:1,title:'new'}]));
 assert.equal((await customStatuses(cwd,changed.tickets)).get(ticket.number),'done');assert.equal(changed.tickets[0].custom.changed,true);
 assert.equal(ticketBranch(ticket),ticketBranch(changed.tickets[0]));
 await createRunFolder(cwd,changed.tickets[0]);assert.equal((await readdir(path.join(folder,'history'))).length,1);
 const unrelated={...ticket,custom:{...ticket.custom,identity:'unrelated'}};assert.equal((await customStatuses(cwd,[unrelated])).size,0);
});
for(const harness of ['claude','codex'])test(`${harness} import invocation restricts writes, strips custom secret, and carries image context`,async t=>{
 environment(t,{CUSTOM_TEST_KEY:'hidden'});const c=cfg(harness);const call=invocation(c,'import',['/tmp/example.png']);
 assert.equal(call.env.CUSTOM_TEST_KEY,undefined);assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));assert.ok(!call.args.includes('--dangerously-skip-permissions'));
 if(harness==='codex'){assert.ok(call.args.includes('--image'));assert.ok(call.args.includes('read-only'));}
 else{assert.equal(call.args[call.args.indexOf('--tools')+1],'Read');assert.ok(call.args.includes('--strict-mcp-config'));}
 const cwd=await temporary(t);await executable(cwd,harness,`let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{const text=JSON.stringify({title:process.env.CUSTOM_TEST_KEY?'LEAK':'safe',description:'ok'});console.log(JSON.stringify(${harness==='codex'?"{type:'item.completed',item:{type:'agent_message',text}}":"{type:'assistant',message:{content:[{type:'text',text}]}}"}));});`);
 environment(t,{PATH:cwd});const result=await runHarness({config:c,phase:'import',prompt:'Convert',cwd,timeoutMs:5000,images:['/tmp/example.png']});assert.equal(JSON.parse(result.text).title,'safe');
});
test('custom full lifecycle creates a custom PR reference without issue actions',async t=>{
 const cwd=await fixture(t);const imported=await importCustom(cfg(),cwd,importer([{id:'task'}]));
 await executable(cwd,'codex',fakeAgent);environment(t,{PATH:cwd,FAKE_MODE:undefined,CAPTURE:path.join(cwd,'calls.jsonl')});
 const c=cfg();c.planMode=false;c.pr.addLabelOnOpen='review';await atomicWriteConfig(c,cwd);
 await runAllTickets(imported.tickets,c,cwd,{onStatusChange(){},onLogLine(){},onComplete(){},onFailure:async(_,s)=>assert.fail(s.failureReason)},undefined,{findPr:async()=>({url:'https://example.com/pr',number:1}),addLabel:async()=>assert.fail('No issue labels'),moveCard:async()=>assert.fail('No Trello completion')});
 const calls=(await readFile(path.join(cwd,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls.some(c=>c.prompt.includes('Implements custom task:')));assert.ok(calls.every(c=>!c.prompt.includes('Closes #')));
 assert.equal((await customStatuses(cwd,imported.tickets)).get(imported.tickets[0].number),'done');
});
test('timestamp includes milliseconds and numeric timezone offset',()=>assert.match(timestamp(new Date()),/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}[+-]\d{4}$/));

test('missing API key prevents any request; secrets are removed from conversion prompts',async t=>{
 const cwd=await fixture(t);delete process.env.CUSTOM_TEST_KEY;
 await assert.rejects(importCustom(cfg(),cwd,{fetcher:async()=>assert.fail('must not fetch')}),/CUSTOM_TEST_KEY/);
 process.env.CUSTOM_TEST_KEY='test-custom-secret';
 await importCustom(cfg(),cwd,{...importer([{id:1,description:'test-custom-secret'}]),harness:async options=>{
  assert.ok(!options.prompt.includes('test-custom-secret'));return ok(draft);
 }});
});
test('failure on a later item removes all staged tasks and retains the prior registry',async t=>{
 const cwd=await fixture(t);await importCustom(cfg(),cwd,importer([{id:'previous'}]));
 const registry=await readFile(path.join(cwd,'.iteris/custom/registry.json'),'utf8');
 const published=await readdir(path.join(cwd,'.tasks'));let calls=0;
 await assert.rejects(importCustom(cfg(),cwd,{...importer([{id:1},{id:2}]),harness:async()=>++calls===1?ok(draft):ok({})}),/validation/);
 assert.equal(calls,3);assert.deepEqual(await readdir(path.join(cwd,'.tasks')),published);
 assert.equal(await readFile(path.join(cwd,'.iteris/custom/registry.json'),'utf8'),registry);
});
test('reimport instructions reuse the stable custom branch',async()=>{
 const {expandPrompt}=await import('../dist/agent/prompt.js');
 const ticket={number:1,title:'A',body:'B',labels:[],slug:'a',htmlUrl:'',custom:{identity:'stable',fingerprint:'f',taskFile:'/task.md'}};
 assert.match(expandPrompt(ticket,cfg(),''),/already exists locally or on origin/);
 assert.match(expandPrompt(ticket,cfg(),''),/iteris\/custom-stable/);
});
test('streamed bytes count against the import budget even on oversized failures',async()=>{
 let bytes=0;
 await assert.rejects(download(custom.endpoint,{endpoint:custom.endpoint,token:'x',maxBytes:1,onBytes:n=>{bytes+=n;},fetcher:async()=>new Response('123')}),/size limit/);
 assert.equal(bytes,3);
});
