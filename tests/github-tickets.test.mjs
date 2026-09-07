import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Octokit} from '@octokit/rest';
import {fetchTodoTickets} from '../dist/github/tickets.js';
import {config, temporary} from './helpers.mjs';
import {atomicWriteConfig, loadConfig} from '../dist/config.js';
function client(handler) {
 return new Octokit({request:{fetch:async(url,options)=>{
  const result=await handler(new URL(url),options);
  return new Response(JSON.stringify(result.body),{status:result.status??200,headers:{'content-type':'application/json',...result.headers}});
 }}});
}
const issue=(number,extra={})=>({number,title:`Issue ${number}`,body:null,labels:[],html_url:`https://github.com/org/repo/issues/${number}`,state:'open',...extra});
for (const source of ['auto', 'projects']) test(`no Projects in ${source} mode: saves issues source before fetching, then skips discovery`,async t=>{
 const cwd=await temporary(t);const cfg={...config(),githubSource:source};await atomicWriteConfig(cfg,cwd);
 const requests=[];
 const api=client(async(url,options)=>{
  requests.push(url.pathname);
  if(url.pathname==='/graphql')return {body:{data:{organization:{projectsV2:{nodes:[]}}}}};
  assert.equal(url.pathname,'/repos/org/repo/issues');assert.equal(url.searchParams.get('state'),'open');
  assert.equal((await loadConfig(cwd)).githubSource,'issues');
  return {body:[issue(1),issue(2,{pull_request:{url:'pr'}}),issue(3,{labels:[{name:'p0'}]})]};
 });
 const result=await fetchTodoTickets(cfg,undefined,api,cwd);
 assert.equal(result.kind,'tickets');assert.deepEqual(result.tickets.map(ticket=>ticket.number),[3,1]);
 assert.equal(result.tickets[0].body,'');assert.deepEqual(requests,['/graphql','/repos/org/repo/issues']);
 assert.equal(cfg.githubSource,'issues');const saved=await loadConfig(cwd);assert.equal(saved.harness,cfg.harness);assert.deepEqual(saved.harnesses,cfg.harnesses);
 requests.length=0;await fetchTodoTickets(saved,undefined,api,cwd);assert.deepEqual(requests,['/repos/org/repo/issues']);
});
test('issues-only mode skips Projects and paginates open issues, excluding PRs',async()=>{
 const pages=[];
 const api=client(url=>{
  assert.equal(url.pathname,'/repos/org/repo/issues');assert.equal(url.searchParams.get('state'),'open');
  assert.equal(url.searchParams.get('labels'),null);pages.push(url.searchParams.get('page'));
  if(!url.searchParams.get('page'))return {body:[issue(1),issue(2,{pull_request:{url:'pr'}})],headers:{link:'<https://api.github.com/repos/org/repo/issues?state=open&page=2>; rel="next"'}};
  return {body:[issue(3,{labels:['p1']}),issue(4,{state:'closed'})]};
 });
 const result=await fetchTodoTickets({...config(),githubSource:'issues',projectNumber:123},undefined,api);
 assert.deepEqual(result.tickets.map(ticket=>ticket.number),[3,1]);assert.equal(pages.length,2);
});
test('empty issue repository returns an empty picker result',async()=>{
 const api=client(url=>{assert.notEqual(url.pathname,'/graphql');return {body:[]};});
 assert.deepEqual(await fetchTodoTickets({...config(),githubSource:'issues'},undefined,api),{kind:'tickets',tickets:[]});
});
test('multiple projects still return the project picker',async()=>{
 const projects=[{number:1,title:'One'},{number:2,title:'Two'}];
 const api=client(url=>{assert.equal(url.pathname,'/graphql');return {body:{data:{organization:{projectsV2:{nodes:projects}}}}};});
 assert.deepEqual(await fetchTodoTickets(config(),undefined,api),{kind:'pickProject',projects});
});
test('authentication failure is not hidden by repository fallback',async()=>{
 const api=client(url=>{assert.equal(url.pathname,'/graphql');return {status:401,body:{message:'Bad credentials'}};});
 await assert.rejects(fetchTodoTickets(config(),undefined,api),/Bad credentials/);
});
test('explicit project with no matching tickets does not fall back to issues',async()=>{
 const api=client((url,options)=>{
  assert.equal(url.pathname,'/graphql');const {query}=JSON.parse(options.body);
  return {body:{data:{organization:query.includes('projectV2(')?{projectV2:{items:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}:{id:'org-id'}}}};
 });
 assert.deepEqual(await fetchTodoTickets({...config(),projectNumber:1},undefined,api),{kind:'tickets',tickets:[]});
});

test('issues preference remains saved if repository fetching fails',async t=>{
 const cwd=await temporary(t);const cfg=config();await atomicWriteConfig(cfg,cwd);
 const api=client(url=>url.pathname==='/graphql'?{body:{data:{organization:{projectsV2:{nodes:[]}}}}}:{status:403,body:{message:'Repository access denied'}});
 await assert.rejects(fetchTodoTickets(cfg,undefined,api,cwd),/Repository access denied/);
 assert.equal((await loadConfig(cwd)).githubSource,'issues');
});
