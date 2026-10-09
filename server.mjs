import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, ClaudeAdapter, findBinary, nativeMessages, isActiveWriterError } from './lib/adapters.mjs';
import { loadStore, contextPrompt, MANAGER_SCHEMA, validateAssignments } from './lib/store.mjs';
import { appIdentity, inspectEnvironment, loadSettings, saveSettings, checkDirectories } from './lib/environment.mjs';
import { describeFailure } from './lib/failures.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENT_ROOM_PORT || 4319);
const store = await loadStore(root);
const state = store.state;
const csrf = randomBytes(24).toString('hex');
const subscribers = new Set();
const settings = await loadSettings(root);
const binaries = Object.fromEntries(await Promise.all(['codex','claude'].map(async kind => [kind, await findBinary(kind, root, settings)])));
const codex = new CodexAdapter(binaries.codex), claude = new ClaudeAdapter(binaries.claude);
let connections = { codex: { ready: false, detail: '正在检查登录' }, claude: { ready: false, detail: '正在检查登录' } };
let dispatching = false, closing = false, environment = null, environmentChecking = false, checking;

function publicState() { return { ...state, app: appIdentity(root), connections, dispatching, environment, environmentChecking, csrf }; }
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const response of subscribers) response.write(payload);
}
function persist() { store.save().catch(error => console.error('保存群聊失败:', error.message)); broadcast(); }
function message(sender, text, extra = {}) {
  const item = { id: randomUUID(), sender, text, at: new Date().toISOString(), ...extra };
  state.messages.push(item); persist(); return item;
}
function getMember(id) {
  const member = state.members.find(x => x.id === id);
  if (!member) throw new Error('这位员工不存在。'); return member;
}
function assertAvailable(member) {
  if (environmentChecking && !environment?.providers) throw new Error('正在检查使用环境，请稍后再发送。');
  if (member.location === 'native' && member.provider !== 'codex') throw new Error(`${member.name} 在原应用中。完成工作后点击“回到群聊”。`);
  if (['thinking','working','connecting'].includes(member.status)) throw new Error(`${member.name} 正忙。`);
  if (!connections[member.provider]?.ready) throw new Error(`${member.provider === 'codex' ? 'Codex' : 'Claude'}：${connections[member.provider]?.detail || '连接不可用'}。请打开“使用前检查”处理。`);
}
async function syncBaseline(member) {
  if (!member.sessionId || (member.provider === 'claude' && !member.sessionCreated)) return;
  const entries = member.provider === 'codex' ? nativeMessages(await codex.read(member)) : await claude.transcript(member);
  member.seenNative = [...new Set([...(member.seenNative || []), ...entries.map(e => e.id)])].slice(-3000);
}
async function respond(member, text, { mode = 'discussion', schema, task } = {}) {
  assertAvailable(member);
  member.status = task ? 'working' : 'thinking'; member.activity = task ? '正在完成任务' : '正在思考'; member.error = null;
  const output = message(member.id, '', { pending: true, kind: task ? 'result' : 'chat', taskId: task?.id });
  if (['discussion','report'].includes(mode)) output.retryRequest = { memberId: member.id, text, mode };
  try {
    const result = await (member.provider === 'codex' ? codex : claude).run(member, contextPrompt(state, member, text, mode), {
      work: mode === 'work', schema,
      onDelta: value => { output.text = value; broadcast(); },
      onActivity: value => { member.activity = value; broadcast(); },
      onRoute: route => {
        member.transport = route; member.location = route === 'native-queue' ? 'native' : 'room';
        output.source = route === 'native-queue' ? '原应用' : undefined; persist();
      },
    });
    output.text = schema ? result.message : result;
    if (!output.text?.trim()) output.text = '已收到。';
    output.pending = false; member.status = 'idle'; member.failure = null; member.activity = member.location === 'native' ? '在原应用中，可从群聊联系' : '';
    await syncBaseline(member).catch(() => {});
    persist(); return result;
  } catch (error) {
    const failure = describeFailure(error);
    output.text = `${failure.message}\n\n${failure.action}`; output.pending = false; output.error = true; output.failure = failure;
    member.status = 'error'; member.failure = failure; member.error = `${failure.message} ${failure.action}`; member.activity = ''; persist(); throw new Error(member.error);
  } finally { await store.save(); }
}

async function workBatch(manager, text) {
  if (dispatching) throw new Error('上一批工作仍在进行，请先等汇报完成。');
  assertAvailable(manager);
  dispatching = true; persist();
  try {
    const plan = await respond(manager, text, { mode: 'planning', schema: MANAGER_SCHEMA });
    const assignments = validateAssignments(plan, state.members);
    const batchId = randomUUID();
    const tasks = assignments.map(assignment => ({
      id: randomUUID(), employeeId: assignment.employeeId, assignedBy: manager.id,
      title: assignment.title, instructions: assignment.instructions, status: 'working',
      createdAt: new Date().toISOString(), batchId,
    }));
    state.tasks.push(...tasks); persist();
    await Promise.all(tasks.map(task => executeTask(task)));
    if (tasks.length && manager.location !== 'native' && !['working','thinking','connecting'].includes(manager.status)) {
      await respond(manager, '本批员工的工作已返回，请基于实际结果向用户汇报。失败或未验证的内容要明确标注。', { mode: 'report' });
    }
  } finally { dispatching = false; persist(); }
}

async function executeTask(task, retry = false) {
  const worker = getMember(task.employeeId);
  try {
    const caution = retry ? '上一轮未完成。先核对已修改文件和已完成步骤，再继续这项原任务，避免重复操作。\n\n' : '';
    task.result = await respond(worker, `${caution}${task.title}\n\n${task.instructions}`, { mode: 'work', task });
    task.status = 'completed'; delete task.error;
  } catch (error) { task.status = worker.failure?.code === 'stopped' ? 'interrupted' : 'failed'; task.error = error.message; }
  task.completedAt = new Date().toISOString(); persist();
}
async function retryTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task || !['failed','interrupted'].includes(task.status)) throw new Error('只能继续未完成或已中断的任务。');
  const worker = getMember(task.employeeId); assertAvailable(worker);
  task.attempts ||= [];
  task.attempts.push({ status: task.status, error: task.error, result: task.result, completedAt: task.completedAt });
  task.status = 'working'; delete task.error; persist();
  message('system', `用户请求 ${worker.name} 核对已有成果后继续“${task.title}”。`, { kind: 'notice' });
  executeTask(task, true).then(async () => {
    const manager = state.members.find(m => m.id === task.assignedBy);
    if (manager && manager.location !== 'native' && !['working','thinking','connecting'].includes(manager.status)) {
      await respond(manager, `用户请求继续的任务“${task.title}”已经返回，请根据实际结果汇报。`, { mode: 'report' });
    }
  }).catch(error => message('system', error.message, { kind: 'notice', error: true }));
}
function retryResponse(id) {
  const original = state.messages.find(m => m.id === id);
  if (!original?.error || !original.failure?.retryable || !original.retryRequest || original.pending) throw new Error('这条消息不能直接重发，请先检查原会话。');
  const { memberId, text, mode } = original.retryRequest;
  if (!['discussion','report'].includes(mode)) throw new Error('执行任务请从任务详情继续。');
  const member = getMember(memberId); assertAvailable(member);
  message('system', `用户请求重新联系 ${member.name}，沿用原来的会话。`, { kind: 'notice' });
  respond(member, text, { mode }).catch(() => {});
}

async function dispatch(body) {
  const text = String(body.text || '').trim();
  if (!text || text.length > 30000) throw new Error('请输入 1–30000 字的消息。');
  const ids = body.recipients === 'all' ? state.members.map(m => m.id) : Array.isArray(body.recipients) ? [...new Set(body.recipients)] : [];
  if (!ids.length) { message('user', text, { kind: 'chat' }); return; }
  const members = ids.map(getMember);
  for (const member of members) assertAvailable(member);
  if (body.mode === 'work') {
    if (members.length !== 1 || members[0].role !== 'manager' || members[0].provider !== 'claude') throw new Error('交办工作请选择一位 Claude 主管。');
    if (dispatching) throw new Error('上一批工作还没有结束。');
    message('user', text, { recipients: ids, kind: 'request' });
    workBatch(members[0], text).catch(error => message('system', `分工未完成：${error.message}`, { kind: 'notice', error: true }));
  } else {
    message('user', text, { recipients: ids, kind: 'chat' });
    Promise.allSettled(members.map(member => respond(member, text)));
  }
}

async function openNative(member) {
  if (environment && !environment.native[member.provider]) throw new Error('原应用入口暂不可用，请打开“使用前检查”查看缺少的程序或接口。');
  assertAvailable(member); member.status = 'connecting'; member.error = null; persist();
  try {
    if (member.provider === 'codex' && member.location !== 'native') {
      try { await codex.prepareNative(member); }
      catch (error) { if (!isActiveWriterError(error)) throw error; }
    }
    else if (member.provider === 'claude' && !member.sessionCreated) {
      member.status = 'idle'; await respond(member, '请简短确认你的员工身份和职责，这个会话将用于持续工作。'); member.status = 'connecting';
    }
    await syncBaseline(member);
    if (member.provider === 'codex') await codex.release(member);
    const launch = member.provider === 'claude' ? await claude.open(member) : {};
    member.location = 'native'; member.status = 'idle'; member.activity = '在原应用中'; persist();
    return { url: member.provider === 'codex' ? `codex://threads/${member.sessionId}` : null, alreadyOpen: Boolean(launch.alreadyOpen) };
  } catch (error) { member.status = 'error'; member.error = error.message; persist(); throw error; }
}
async function syncNative(member) {
  if (!member.sessionId) return;
  // A queued room request already has its own output bubble. Importing the
  // same turn while it is being tracked would duplicate that reply.
  if (['working','thinking','connecting'].includes(member.status)) return;
  const entries = member.provider === 'codex' ? nativeMessages(await codex.read(member)) : await claude.transcript(member);
  const seen = new Set(member.seenNative || []);
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    message(member.id, entry.text, { kind: 'native', source: '原应用', nativeId: entry.id });
  }
  member.seenNative = [...seen].slice(-3000); persist();
}
async function returnToRoom(member) {
  if (member.location !== 'native') return;
  if (['working','thinking','connecting'].includes(member.status)) throw new Error('群聊正在等待这位员工的回复，请先等这一轮结束。');
  if (member.provider === 'codex') {
    const thread = await codex.read(member);
    if (thread.turns?.at(-1)?.status === 'inProgress') throw new Error('这位员工仍在原应用工作，请先结束那一轮。');
  }
  await syncNative(member);
  if (member.provider === 'codex') {
    try { await codex.ensureSession(member); }
    catch (error) {
      if (!isActiveWriterError(error)) throw error;
      member.status = 'idle'; member.error = null; member.transport = 'native-queue'; persist();
      message('system', `${member.name} 的会话仍由 Codex 原应用保持。现在可以直接从群聊联系，消息会投递到同一个原会话。`, { kind: 'notice' });
      return;
    }
  }
  member.location = 'room'; member.transport = 'direct'; member.status = 'idle'; member.error = null; member.activity = ''; persist();
  message('system', `${member.name} 已回到群聊，会继续沿用原来的会话。`, { kind: 'notice' });
}

async function configureMember(body) {
  if (!['claude','codex'].includes(body.provider)) throw new Error('请选择 Claude 或 Codex。');
  if (!['worker','manager'].includes(body.role)) throw new Error('请选择员工职责。');
  if (body.role === 'manager' && body.provider !== 'claude') throw new Error('这个版本的主管使用 Claude。');
  const name = String(body.name || '').trim(), responsibility = String(body.responsibility || '').trim();
  if (!name || name.length > 40 || !responsibility || responsibility.length > 3000) throw new Error('请填写员工姓名和职责。');
  const cwd = resolve(String(body.cwd || join(root,'workspace')));
  if (!(await checkDirectories([{ cwd }]))[0].ready) throw new Error('请选择存在且可读写的项目文件夹。');
  let member = body.id ? getMember(body.id) : null;
  if (member && (['working','thinking','connecting'].includes(member.status) || member.location === 'native')) throw new Error('员工正忙，请回到群聊后再修改。');
  const sessionId = String(body.sessionId || '').trim();
  if (sessionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new Error('请填写完整会话 ID（UUID）。');
  if (sessionId && state.members.some(m => m.id !== member?.id && m.sessionId === sessionId)) throw new Error('一个会话只能绑定一位员工。');
  const changedSession = member && (member.provider !== body.provider || member.sessionId !== (sessionId || null));
  if (changedSession && member.provider === 'codex') await codex.release(member).catch(() => {});
  const values = { name, responsibility, cwd, provider: body.provider, role: body.role };
  if (!member) {
    member = { id: randomUUID(), ...values, sessionId: sessionId || (body.provider === 'claude' ? randomUUID() : null), sessionCreated: Boolean(sessionId), externalSession: Boolean(sessionId), status: 'idle', location: 'room', color: body.provider === 'claude' ? 'clay' : 'green', seenNative: [] };
    state.members.push(member);
  } else {
    Object.assign(member, values);
    if (changedSession) Object.assign(member, { sessionId: sessionId || (body.provider === 'claude' ? randomUUID() : null), sessionCreated: Boolean(sessionId), externalSession: Boolean(sessionId), seenNative: [], status: 'idle', error: null });
  }
  if (member.externalSession) await syncBaseline(member).catch(() => {});
  persist(); return member;
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
}
async function bodyOf(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 100000) throw new Error('消息太长。'); }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('请求格式有误。'); }
}
const server = http.createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${port}`;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) return json(response, 403, { error: '仅接受本机访问。' });
  if (request.headers.origin && ![origin, `http://localhost:${port}`].includes(request.headers.origin)) return json(response, 403, { error: '请从本机群聊页面操作。' });
  response.setHeader('x-content-type-options', 'nosniff');
  const path = new URL(request.url, origin).pathname;
  try {
    if (path === '/api/health' && request.method === 'GET') return json(response, 200, { app: appIdentity(root), busy: dispatching || state.members.some(m => ['working','thinking','connecting'].includes(m.status)) });
    if (path === '/api/state' && request.method === 'GET') return json(response, 200, publicState());
    if (path === '/api/events' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      response.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`); subscribers.add(response);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
      request.on('close', () => { subscribers.delete(response); clearInterval(heartbeat); }); return;
    }
    if (path.startsWith('/api/') && request.method === 'POST') {
      if (request.headers['x-room-token'] !== csrf) return json(response, 403, { error: '页面已失效，请刷新后重试。' });
      const body = await bodyOf(request);
      if (path === '/api/messages') { await dispatch(body); return json(response, 202, { ok: true }); }
      if (path === '/api/retry') { retryResponse(body.id); return json(response, 202, { ok: true }); }
      if (path === '/api/retry-task') { await retryTask(body.id); return json(response, 202, { ok: true }); }
      if (path === '/api/settings') {
        if (dispatching || state.members.some(m => ['working','thinking','connecting'].includes(m.status))) throw new Error('请先等待当前工作结束，再修改程序位置。');
        await saveSettings(root, body); await refreshConnections(); return json(response, 200, environment);
      }
      if (path === '/api/member') return json(response, 200, await configureMember(body));
      if (path === '/api/open') return json(response, 200, await openNative(getMember(body.id)));
      if (path === '/api/return') { await returnToRoom(getMember(body.id)); return json(response, 200, { ok: true }); }
      if (path === '/api/sync') {
        await Promise.all(state.members.filter(m => m.location === 'native').map(async m => { await syncNative(m); m.syncError = null; })); return json(response, 200, { ok: true });
      }
      if (path === '/api/stop') {
        const member = getMember(body.id); await (member.provider === 'codex' ? codex : claude).stop(member); return json(response, 200, { ok: true });
      }
      if (path === '/api/connections') { await refreshConnections(); return json(response, 200, connections); }
      if (path === '/api/shutdown') {
        if (dispatching || state.members.some(m => ['working','thinking','connecting'].includes(m.status))) throw new Error('当前仍有工作正在进行，请先完成或停止这一轮。');
        json(response, 200, { ok: true }); setTimeout(close, 50); return;
      }
      if (path === '/api/remove') {
        const member = getMember(body.id);
        if (['working','thinking','connecting'].includes(member.status) || member.location === 'native') throw new Error('请先结束工作并回到群聊。');
        if (state.tasks.some(t => t.employeeId === member.id && t.status === 'working')) throw new Error('员工还有未结束的任务。');
        if (member.provider === 'codex') await codex.release(member).catch(() => {});
        // Retain name on old messages so the history remains understandable.
        for (const item of state.messages) if (item.sender === member.id) item.senderName = member.name;
        state.members = state.members.filter(m => m.id !== member.id); persist(); return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: '没有这个操作。' });
    }
    const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
    if (request.method === 'GET' && files[path]) {
      const [file, type] = files[path];
      response.writeHead(200, {
        'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      });
      return response.end(await readFile(join(root, 'public', file)));
    }
    json(response, 404, { error: '页面不存在。' });
  } catch (error) { json(response, 400, { error: error.message }); }
});
async function refreshConnections() {
  if (checking) return checking;
  environmentChecking = true; broadcast();
  checking = (async () => {
    environment = await inspectEnvironment(root, state.members);
    connections = environment.providers;
    if (!state.members.some(m => ['working','thinking','connecting'].includes(m.status))) {
      if (codex.binary !== environment.settings.codexBinary) await codex.setBinary(environment.settings.codexBinary || null);
      claude.binary = environment.settings.claudeBinary || null;
    }
  })().catch(error => { environment = { ready: false, error: '启动检查未完成，请重新检查程序配置。' }; }).finally(() => { environmentChecking = false; checking = null; broadcast(); });
  return checking;
}
server.listen(port, '127.0.0.1', () => { console.log(`Agent Room 已启动：http://127.0.0.1:${port}`); refreshConnections(); });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已使用。已有版本可能正在运行。` : error.message); process.exit(1); });
const polling = setInterval(async () => {
  if (closing || environmentChecking) return;
  for (const member of state.members.filter(m => m.location === 'native' && !m.syncing)) {
    member.syncing = true;
    try { await syncNative(member); member.syncError = null; }
    catch (error) { member.syncError = error.message; broadcast(); }
    finally { member.syncing = false; }
  }
}, 12000);
async function close() {
  if (closing) return; closing = true; clearInterval(polling);
  codex.close(); claude.close(); await store.save();
  for (const response of subscribers) response.end(); server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', close); process.on('SIGTERM', close);
