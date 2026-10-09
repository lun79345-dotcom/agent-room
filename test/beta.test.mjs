import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProvider, saveSettings, checkDirectories, appIdentity } from '../lib/environment.mjs';
import { describeFailure } from '../lib/failures.mjs';
import { matchingInstance } from '../launch.mjs';
import { RELEASE_FILES } from '../scripts/package.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('启动检查区分缺失、未登录、缺少接口，不因版本号较新而误报可用', async () => {
  assert.equal((await inspectProvider('codex', null)).installed, false);
  const execute = async (file, args) => ({ stdout: args[0] === '--version' ? '99.0.0 (Claude Code)' : '--resume --session-id --tools' });
  const missing = await inspectProvider('claude','/fake',{ execute, authenticate: async () => ({ready:true}) });
  assert.equal(missing.ready, false); assert.equal(missing.authenticated, true); assert.equal(missing.detail,'需要兼容版本');
  const notLoggedIn = await inspectProvider('codex','/fake',{ execute: async () => ({stdout:'codex-cli 99.0.0'}), authenticate: async () => ({ready:false}), inspectSchema: async () => ({room:true,queue:true}) });
  assert.equal(notLoggedIn.ready,false); assert.equal(notLoggedIn.detail,'需要登录');
  const partial = await inspectProvider('codex','/fake',{ execute: async () => ({stdout:'codex-cli 99.0.0'}), authenticate: async () => ({ready:true}), inspectSchema: async () => ({room:true,queue:false}) });
  assert.equal(partial.ready,true); assert.equal(partial.features.queue,false);
});

test('程序配置拒绝相对路径，工作目录检查拒绝文件，启动器区分不同副本', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agent-room-beta-config-'));
  try {
    await assert.rejects(saveSettings(dir,{codexBinary:'relative/codex'}),/完整文件路径/);
    const file=join(dir,'ordinary.txt');await writeFile(file,'example');
    assert.equal((await checkDirectories([{cwd:file}]))[0].ready,false);
    assert.equal((await checkDirectories([{cwd:dir}]))[0].ready,true);
    assert.equal(matchingInstance({app:appIdentity(dir)},dir),true);
    assert.equal(matchingInstance({app:appIdentity(dir)},dir+'-other'),false);
    assert.equal(matchingInstance({app:{id:'another-service'}},dir),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('故障提示不泄露鉴权错误中的凭证，投递状态不确定时不建议重发', () => {
  const auth=describeFailure(new Error('401 Unauthorized token sk-private-test'));
  assert.equal(auth.code,'auth'); assert.equal(JSON.stringify(auth).includes('sk-private-test'),false);
  assert.equal(describeFailure(new Error('Codex turn/start 超时。')).retryable,false);
  assert.equal(describeFailure(new Error('stream disconnected')).retryable,true);
  assert.equal(describeFailure(new Error('usage_limit_reached 429')).code,'quota');
});

test('发布清单排除聊天数据、工作目录、截图、用户程序配置，版本一致', async () => {
  assert.equal(RELEASE_FILES.some(path=>/^(\.data|workspace|node_modules|release)\//.test(path)||path.endsWith('.jpg')),false);
  const p=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  assert.equal(p.version,appIdentity(root).version);
  const adapter=await readFile(join(root,'lib/adapters.mjs'),'utf8');
  assert.equal(adapter.includes('agentbridge-trial'),false);
});

const fakeProgram = `#!${process.execPath}
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
const a=process.argv.slice(2),isClaude=process.argv[1].includes('fake-claude');
if(a[0]==='--version'){console.log(isClaude?'2.1.295 (Claude Code)':'codex-cli 0.162.0-alpha.2');process.exit(0)}
if(a[0]==='--help'){console.log('--safe-mode --output-format --include-partial-messages --json-schema --resume --session-id --tools --desktop');process.exit(0)}
if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
if(a.includes('generate-json-schema')){const p=a[a.indexOf('--out')+1]+'/v2';mkdirSync(p,{recursive:true});for(const n of ['TurnStartParams','ThreadQueueAddParams','ThreadQueueListParams','ThreadQueueDeleteParams','ThreadQueueStartParams'])writeFileSync(p+'/'+n+'.json','{}');process.exit(0)}
if(isClaude){console.log(JSON.stringify({type:'system',subtype:'init'}));console.log(JSON.stringify({type:'result',is_error:false,result:'主管已回复',structured_output:{message:'测试分工',assignments:[{employeeId:'worker-a',title:'测试任务',instructions:'FAIL_WORK_ONCE'}]}}));process.exit(0)}
let db={threads:{},counts:{},calls:[]};try{db=JSON.parse(readFileSync('.fake-calls.json','utf8'))}catch{}
const save=()=>writeFileSync('.fake-calls.json',JSON.stringify(db));
const out=x=>console.log(JSON.stringify(x));
const result=(id,value)=>out({id,result:value});
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line),p=q.params||{},t=db.threads[p.threadId];
 if(q.id===undefined)return;
 if(q.method==='initialize')return result(q.id,{});
 if(q.method==='thread/start'){const id=randomUUID();db.threads[id]={id,turns:[]};save();return result(q.id,{thread:db.threads[id]})}
 if(q.method==='thread/resume'){if(!t){out({id:q.id,error:{message:'thread not found'}});return}return result(q.id,{thread:t})}
 if(q.method==='thread/read')return result(q.id,{thread:t});
 if(q.method==='turn/start'){
  const text=p.input[0].text.split('本轮用户/系统要求：').at(-1),marker=text.includes('FAIL_WORK_ONCE')?'FAIL_WORK_ONCE':text.includes('FAIL_ONCE')?'FAIL_ONCE':'OK';
  db.calls.push({threadId:p.threadId,marker,text});const key=p.threadId+marker;const count=db.counts[key]=(db.counts[key]||0)+1;
  const turn={id:randomUUID(),status:'inProgress',items:[]};t.turns.push(turn);save();result(q.id,{turn});
  if(text.includes('WAIT_FOR_TEST'))return;
  setTimeout(()=>{turn.status=marker!=='OK'&&count===1?'failed':'completed';if(turn.status==='failed')turn.error={message:'stream disconnected'};else{const item={id:randomUUID(),type:'agentMessage',text:'测试回复已完成'};turn.items.push(item);out({method:'item/completed',params:{threadId:p.threadId,item}})}save();out({method:'turn/completed',params:{threadId:p.threadId,turn}})},30);return;
 }
 if(q.method==='turn/interrupt'){const turn=t.turns.find(x=>x.id===p.turnId);turn.status='interrupted';save();result(q.id,{});out({method:'turn/completed',params:{threadId:p.threadId,turn}});return}
 result(q.id,{});
});
`;

async function freePort(){return await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})}
async function until(check){const start=Date.now();while(Date.now()-start<15000){const value=await check();if(value)return value;await delay(50)}throw new Error('等待测试状态超时')}

test('隔离实例中手动重发沿用固定会话，继续任务保留记录，忙时拒绝关闭', {timeout:25000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'agent-room-beta-integration-')),port=await freePort();let child;
  try {
    for(const f of RELEASE_FILES.filter(f=>!f.startsWith('test/'))){const dest=join(dir,f);await mkdir(dirname(dest),{recursive:true});await copyFile(join(root,f),dest)}
    for(const kind of ['claude','codex']){const file=join(dir,'fake-'+kind+'.mjs');await writeFile(file,fakeProgram);await chmod(file,0o755)}
    child=spawn(process.execPath,['server.mjs'],{cwd:dir,stdio:'ignore',env:{...process.env,AGENT_ROOM_PORT:String(port),AGENT_ROOM_CODEX:join(dir,'fake-codex.mjs'),AGENT_ROOM_CLAUDE:join(dir,'fake-claude.mjs')}});
    const base='http://127.0.0.1:'+port;
    const state=async()=>{try{return await(await fetch(base+'/api/state')).json()}catch{return null}};
    let s=await until(async()=>{const s=await state();return s?.environment?.ready?s:null});
    assert.equal(s.messages.length,1);assert.equal(s.members[1].sessionId,null);const managerId=s.members[0].sessionId;
    const post=async(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-room-token':s.csrf},body:JSON.stringify(body)});
    assert.equal((await post('messages',{text:'FAIL_ONCE',recipients:['worker-a']})).status,202);
    s=await until(async()=>{const s=await state();return s?.members[1].status==='error'?s:null});
    const threadId=s.members[1].sessionId,failed=s.messages.at(-1);
    assert.equal(failed.failure.code,'connection');assert.ok(failed.retryRequest);
    assert.equal((await post('retry',{id:failed.id})).status,202);
    s=await until(async()=>{const s=await state();return s?.messages.at(-1)?.text==='测试回复已完成'&&!s.messages.at(-1).pending?s:null});
    assert.equal(s.members[1].sessionId,threadId);assert.equal(s.members[0].sessionId,managerId);
    assert.equal((await post('messages',{text:'交办测试任务',mode:'work',recipients:['manager']})).status,202);
    s=await until(async()=>{const s=await state();return s?.tasks[0]?.status==='failed'&&!s.dispatching?s:null});
    const taskId=s.tasks[0].id;
    assert.equal((await post('retry-task',{id:taskId})).status,202);
    s=await until(async()=>{const s=await state();return s?.tasks[0]?.status==='completed'&&s.members.every(m=>m.status!=='thinking')?s:null});
    assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].attempts.length,1);assert.equal(s.members[1].sessionId,threadId);
    const calls=JSON.parse(await readFile(join(dir,'.fake-calls.json'),'utf8')).calls;
    const work=calls.filter(c=>c.marker==='FAIL_WORK_ONCE');assert.equal(work.length,2);assert.match(work[1].text,/先核对已修改文件/);
    assert.equal((await post('messages',{text:'WAIT_FOR_TEST',recipients:['worker-a']})).status,202);
    await until(async()=>{const x=await state();return x?.members[1].status==='thinking'});
    assert.equal((await post('shutdown',{})).status,400);
    assert.equal((await post('stop',{id:'worker-a'})).status,200);
    await until(async()=>{const x=await state();return x?.members[1].status==='error'});
    assert.equal((await post('shutdown',{})).status,200);
    await until(async()=>!await state());
  } finally {child?.kill('SIGTERM');await delay(100);await rm(dir,{recursive:true,force:true})}
});
