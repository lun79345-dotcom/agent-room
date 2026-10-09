import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, validateAssignments, contextPrompt } from '../lib/store.mjs';
import { CodexAdapter, nativeMessages, queuedTurn, persistedTurnEnd } from '../lib/adapters.mjs';

const workers = [
  { id: 'a', provider: 'codex', role: 'worker', name: '小林', location: 'room', status: 'idle' },
  { id: 'b', provider: 'codex', role: 'worker', name: '小陈', location: 'room', status: 'idle' },
  { id: 'm', provider: 'claude', role: 'manager', name: '主管', location: 'room', status: 'idle' },
];
const assignment = employeeId => ({ employeeId, title: '任务', instructions: '完成任务并验证' });

test('主管不能分配给不存在、重复或正忙的员工，可联系原应用中的 Codex', () => {
  const plan = { message: '开始分工', assignments: [assignment('a'),assignment('b')] };
  assert.equal(validateAssignments(plan, workers).length, 2);
  assert.throws(() => validateAssignments({ ...plan, assignments: [assignment('x')] }, workers), /不存在/);
  assert.throws(() => validateAssignments({ ...plan, assignments: [assignment('m')] }, workers), /不存在/);
  assert.throws(() => validateAssignments({ ...plan, assignments: [assignment('a'),assignment('a')] }, workers), /同时分配/);
  assert.equal(validateAssignments(plan, workers.map(m => ({ ...m, location: m.id === 'a' ? 'native' : 'room' }))).length, 2);
  assert.throws(() => validateAssignments(plan, workers.map(m => ({ ...m, status: m.id === 'b' ? 'working' : 'idle' }))), /正忙/);
});

test('重启保留员工固定会话并明确中断状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-room-'));
  try {
    const first = await loadStore(root); const id = first.state.members[0].sessionId;
    first.state.members[0].status = 'thinking';
    first.state.members[1].syncing = true;
    first.state.messages.push({ id: 'pending', sender: 'manager', pending: true, text: '' });
    first.state.tasks.push({ id: 'task', status: 'working' });
    await first.save();
    const second = await loadStore(root);
    assert.equal(second.state.members[0].sessionId, id);
    assert.equal(second.state.members[0].status, 'error');
    assert.equal(second.state.members[1].syncing, false);
    assert.equal(second.state.messages.at(-1).pending, false);
    assert.equal(second.state.tasks[0].status, 'interrupted');
    assert.equal(JSON.parse(await readFile(join(root, '.data/room.json'), 'utf8')).members[0].sessionId, id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex 两位员工的流式事件和完成结果彼此隔离', async () => {
  const adapter = new CodexAdapter(null);
  const results = [];
  for (const id of ['a','b']) adapter.active.set(id, { text: '', messages: new Map(), timer: setTimeout(() => {}, 10000), resolve: text => results.push([id,text]), reject: assert.fail });
  adapter.handle({ method: 'item/agentMessage/delta', params: { threadId: 'b', delta: 'B 的流' } });
  adapter.handle({ method: 'item/completed', params: { threadId: 'a', item: { type: 'agentMessage', id: 'msg', text: 'A 的工作结果' } } });
  adapter.handle({ method: 'item/completed', params: { threadId: 'b', item: { type: 'agentMessage', id: 'msg', text: 'B 的工作结果' } } });
  adapter.handle({ method: 'turn/completed', params: { threadId: 'b', turn: { status: 'completed' } } });
  adapter.handle({ method: 'turn/completed', params: { threadId: 'a', turn: { status: 'completed' } } });
  assert.deepEqual(results, [['b','B 的工作结果'],['a','A 的工作结果']]);
  assert.equal(adapter.active.size, 0);
});

test('原应用只同步已完成的代理回复，不暴露工具或推理记录', () => {
  const result = nativeMessages({ turns: [
    { id: 'one', status: 'completed', items: [{ id: 'x',type: 'agentMessage',text: '已完成' },{ type: 'reasoning',text: '内部内容' }] },
    { id: 'two', status: 'inProgress', items: [{ id: 'y',type: 'agentMessage',text: '尚在执行' }] },
  ] });
  assert.deepEqual(result, [{ id: 'one:x', text: '已完成' }]);
});

test('员工提示携带当前职责与真实任务状态，汇报轮不再分工', () => {
  const state = { members: workers, messages: [{ sender:'user',text:'需求' }],tasks:[{title:'任务A',employeeId:'a',status:'failed',error:'连接中断'}] };
  const prompt = contextPrompt(state, workers[2], '汇报', 'report');
  assert.match(prompt, /failed/); assert.match(prompt, /连接中断/); assert.match(prompt, /只汇报，不再安排新任务/);
});

test('原应用队列按客户端消息 ID 匹配回复，忽略其他轮次的完成事件', async () => {
  const adapter = new CodexAdapter(null), controller = new AbortController();
  adapter.active.set('a', { queued: true, controller });
  adapter.handle({ method: 'turn/completed', params: { threadId: 'a', turn: { status: 'completed' } } });
  assert.equal(adapter.active.size, 1);
  const own = { id: 'own', status: 'completed', items: [{ type: 'userMessage', clientId: 'request-a' }] };
  assert.equal(queuedTurn({ turns: [{ id: 'unrelated', items: [{ type: 'userMessage', clientId: 'request-b' }] }, own] }, 'request-a'), own);
  assert.equal(queuedTurn({ turns: [own] }, 'request-b'), undefined);
});

test('会话由原应用持有时改为同一会话投递，其他连接错误直接报告', async () => {
  const adapter = new CodexAdapter(null), member = { sessionId: 'fixed-thread' };
  adapter.ensureSession = async () => { throw new Error('thread fixed-thread already has an active writer'); };
  adapter.runQueued = async (m, prompt) => { assert.equal(m.sessionId, 'fixed-thread'); assert.equal(prompt, '原消息'); return '原会话回复'; };
  assert.equal(await adapter.run(member, '原消息'), '原会话回复');
  adapter.ensureSession = async () => { throw new Error('authentication failed'); };
  await assert.rejects(adapter.run(member, '原消息'), /authentication failed/);
});

test('已经开始的原应用工作不能伪装为已停止，排队消息可以撤回', async () => {
  const adapter = new CodexAdapter(null), controller = new AbortController();
  adapter.active.set('a', { queued: true, queuedId: 'queued-a', controller });
  adapter.request = async () => ({ data: [] });
  await assert.rejects(adapter.stop({ sessionId: 'a' }), /在原会话点击停止/);
  assert.equal(controller.signal.aborted, false);
  const calls = [];
  adapter.request = async (method, params) => { calls.push([method, params]); return { data: [{ id: 'queued-a' }] }; };
  await adapter.stop({ sessionId: 'a' });
  assert.equal(controller.signal.aborted, true);
  assert.equal(calls[1][0], 'thread/queue/delete');
});

test('读取未加载会话时的中断状态要由原会话结束记录确认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-room-end-'));
  const file = join(root, 'own.jsonl');
  try {
    const event = type => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'own-turn' } }) + '\n';
    await writeFile(file, event('task_started'));
    assert.equal(await persistedTurnEnd(file, 'own-turn'), null);
    const adapter = new CodexAdapter(null);
    adapter.connect = async () => {};
    adapter.request = async () => ({ queuedSubmission: { id: 'queued' } });
    let reads = 0;
    adapter.read = async () => ({ path: file, turns: [{ id: 'own-turn', status: ++reads === 1 ? 'interrupted' : 'completed', items: [
      { type: 'userMessage', clientId: [...adapter.active.values()][0].clientId },
      { type: 'agentMessage', text: reads === 1 ? '' : '完整回复' },
    ] }] });
    assert.equal(await adapter.runQueued({ sessionId: 'same-thread' }, '原消息'), '完整回复');
    await writeFile(file, event('task_started') + event('turn_aborted'));
    assert.equal(await persistedTurnEnd(file, 'own-turn'), 'interrupted');
    assert.equal(await persistedTurnEnd(file, 'unrelated-turn'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
