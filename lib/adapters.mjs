import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { access, readdir, readFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export async function findBinary(kind, root, settings = {}) {
  const candidates = kind === 'codex' ? [
    process.env.AGENT_ROOM_CODEX,
    settings.codexBinary,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    join(homedir(), '.local/bin/codex'),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  ] : [
    process.env.AGENT_ROOM_CLAUDE,
    settings.claudeBinary,
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/node_modules/.bin/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ];
  for (const item of candidates.filter(Boolean)) {
    try { await access(item, 1); return item; } catch {}
  }
  try { return (await exec('/usr/bin/which', [kind])).stdout.trim(); } catch { return null; }
}

export async function checkConnection(kind, binary) {
  if (!binary) return { ready: false, detail: '尚未安装' };
  try {
    const { stdout, stderr } = await exec(binary, kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { timeout: 15000, maxBuffer: 100000 });
    const ready = kind === 'claude' ? Boolean(JSON.parse(stdout).loggedIn) : /logged in/i.test(stdout + stderr);
    return { ready, detail: ready ? '使用现有登录' : '需要登录' };
  } catch { return { ready: false, detail: '登录状态不可用' }; }
}

export class CodexAdapter extends EventEmitter {
  constructor(binary) {
    super(); this.binary = binary; this.pending = new Map(); this.active = new Map(); this.sequence = 0; this.loaded = new Set();
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize().catch(error => { this.connecting = null; throw error; });
    return this.connecting;
  }
  async initialize() {
    if (!this.binary) throw new Error('找不到 Codex，请先安装或配置 AGENT_ROOM_CODEX。');
    const child = this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.diagnostics = '';
    child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-3000); });
    createInterface({ input: child.stdout }).on('line', line => {
      try { this.handle(JSON.parse(line)); } catch (error) { this.emit('diagnostic', error.message); }
    });
    const fail = error => {
      if (this.child !== child) return;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      for (const p of this.active.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.active.clear(); this.loaded.clear(); this.child = null; this.connecting = null;
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('Codex 连接已关闭。请重试。')));
    await this.request('initialize', { clientInfo: { name: 'agent_room', title: 'Agent Room', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  send(value) {
    if (!this.child?.stdin.writable) throw new Error('Codex 尚未连接。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  handle(event) {
    if (event.id !== undefined && (event.result !== undefined || event.error)) {
      const pending = this.pending.get(event.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(event.id);
        event.error ? pending.reject(new Error(event.error.message)) : pending.resolve(event.result);
      }
      return;
    }
    // Group discussion uses read-only tools. Work turns use a workspace sandbox;
    // approvals and interactive questions are surfaced, never silently approved.
    if (event.id !== undefined && event.method) {
      const request = this.active.get(event.params?.threadId);
      request?.onActivity?.('需要在原应用处理确认或补充信息');
      if (event.method.includes('requestApproval')) this.send({ id: event.id, result: { decision: 'decline' } });
      else if (event.method === 'item/tool/requestUserInput') this.send({ id: event.id, result: { answers: {} } });
      else this.send({ id: event.id, error: { code: -32601, message: 'Agent Room does not handle this request.' } });
      return;
    }
    const p = event.params || {};
    const run = this.active.get(p.threadId);
    if (run && !run.queued) {
      if (event.method === 'item/agentMessage/delta') {
        run.text += p.delta; run.onDelta?.(run.text);
      }
      if (event.method === 'item/started') {
        const item = p.item || {};
        if (item.type === 'commandExecution') run.onActivity?.('正在执行工作目录中的任务');
        if (item.type === 'fileChange') run.onActivity?.('正在修改文件');
      }
      if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
        run.messages.set(p.item.id, p.item.text || '');
      }
      if (event.method === 'turn/completed') {
        this.active.delete(p.threadId); clearTimeout(run.timer);
        const text = [...run.messages.values()].join('\n\n') || run.text;
        p.turn?.status === 'failed' ? run.reject(new Error(p.turn.error?.message || 'Codex 工作失败。')) :
          p.turn?.status === 'interrupted' ? run.reject(new Error('已停止。')) : run.resolve(text);
      }
    }
    this.emit('notification', event);
  }
  async ensureSession(member) {
    await this.connect();
    if (member.sessionId && this.loaded.has(member.sessionId)) return member.sessionId;
    const params = { cwd: member.cwd, approvalPolicy: 'never', sandbox: 'read-only' };
    const result = member.sessionId
      ? await this.request('thread/resume', { ...params, threadId: member.sessionId })
      : await this.request('thread/start', { ...params, developerInstructions: `你是团队员工 ${member.name}。职责：${member.responsibility}。持续使用这个会话完成你的工作。` });
    member.sessionId = result.thread.id; this.loaded.add(member.sessionId);
    if (!member.externalSession) await this.request('thread/name/set', { threadId: member.sessionId, name: `Agent Room · ${member.name}` }).catch(() => {});
    return member.sessionId;
  }
  async run(member, prompt, options = {}) {
    const { work = false, onDelta, onActivity } = options;
    if (this.active.has(member.sessionId)) throw new Error('这个员工正在工作。');
    if (member.location === 'native' && member.sessionId) return this.runQueued(member, prompt, options);
    try { await this.ensureSession(member); }
    catch (error) {
      if (member.sessionId && isActiveWriterError(error)) return this.runQueued(member, prompt, options);
      throw error;
    }
    const threadId = member.sessionId;
    if (this.active.has(threadId)) throw new Error('这个员工正在工作。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(member).catch(() => {}); this.active.delete(threadId); reject(new Error('这轮工作超过 15 分钟，已请求停止。'));
      }, 15 * 60000);
      const run = { resolve, reject, onDelta, onActivity, timer, text: '', messages: new Map() };
      this.active.set(threadId, run);
      this.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }], approvalPolicy: 'never', cwd: member.cwd,
        sandboxPolicy: work ? { type: 'workspaceWrite', writableRoots: [member.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : { type: 'readOnly' },
      }).then(result => { run.turnId = result.turn.id; }).catch(error => {
        this.active.delete(threadId); clearTimeout(timer); reject(error);
      });
    });
  }
  async runQueued(member, prompt, { work = false, onDelta, onActivity, onRoute } = {}) {
    await this.connect();
    const threadId = member.sessionId;
    if (this.active.has(threadId)) throw new Error('这个员工正在工作。');
    const controller = new AbortController(), clientId = randomUUID();
    const run = { queued: true, clientId, controller, onActivity, reject: error => controller.abort(error) };
    run.timer = setTimeout(() => controller.abort(new Error('等待原应用回复超过 15 分钟，请到原会话检查进度；已经开始的工作不会被强行关闭。')), 15 * 60000);
    this.active.set(threadId, run);
    let completed = false, lastText = '', nextActivation = Date.now() + 10000;
    try {
      onRoute?.('native-queue');
      onActivity?.('已投递到原会话，等待原应用接收');
      const result = await this.request('thread/queue/add', {
        threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: prompt }],
      });
      run.queuedId = result.queuedSubmission.id;
      while (true) {
        controller.signal.throwIfAborted();
        const thread = await this.read(member);
        const turn = queuedTurn(thread, clientId);
        if (turn) {
          run.turnId = turn.id;
          const text = turn.items.filter(item => item.type === 'agentMessage').map(item => item.text || '').join('\n\n');
          if (text && text !== lastText) { lastText = text; onDelta?.(text); }
          if (turn.status === 'completed') { completed = true; return text; }
          if (turn.status === 'failed') throw new Error(turn.error?.message || '原应用中的工作失败。');
          // An unloaded reader hydrates an unfinished foreign turn as
          // interrupted. Only the writer's persisted abort event is final.
          if (turn.status === 'interrupted' && await persistedTurnEnd(thread.path, turn.id) === 'interrupted') throw new Error('已停止。');
          onActivity?.('原应用正在回复，确认请求请在原应用处理');
        } else if (Date.now() >= nextActivation) {
          nextActivation = Date.now() + 10000;
          // If the original application has released its writer, resume the
          // same thread and start this exact queued item. Never fork or retry
          // the user input as a second independent turn.
          try {
            await this.ensureSession(member);
            onRoute?.('direct-queue');
            await this.request('thread/resume', { threadId, cwd: member.cwd, approvalPolicy: 'never', sandbox: work ? 'workspace-write' : 'read-only' });
            await this.request('thread/queue/start', { threadId, queuedSubmissionId: run.queuedId }).catch(() => {});
          } catch (error) { if (!isActiveWriterError(error)) throw error; }
        }
        await delay(1500, undefined, { signal: controller.signal });
      }
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(run.timer);
      if (this.active.get(threadId) === run) this.active.delete(threadId);
      // Delete only a submission still waiting in the shared queue. A consumed
      // submission belongs to the original application and keeps running there.
      if (!completed && run.queuedId) await this.request('thread/queue/delete', { threadId, queuedSubmissionId: run.queuedId }).catch(() => {});
    }
  }
  async stop(member) {
    const run = this.active.get(member.sessionId);
    if (run?.queued) {
      if (run.turnId && this.loaded.has(member.sessionId)) {
        await this.request('turn/interrupt', { threadId: member.sessionId, turnId: run.turnId }); return;
      }
      if (!run.queuedId) throw new Error('消息正在投递，请稍后重试。');
      const queue = await this.request('thread/queue/list', { threadId: member.sessionId, limit: 100 });
      if (!queue.data.some(item => item.id === run.queuedId)) throw new Error('这轮已在原应用开始，请在原会话点击停止；群聊会继续同步结果。');
      await this.request('thread/queue/delete', { threadId: member.sessionId, queuedSubmissionId: run.queuedId });
      run.controller.abort(new Error('已停止。')); return;
    }
    if (run?.turnId) await this.request('turn/interrupt', { threadId: member.sessionId, turnId: run.turnId });
  }
  async read(member) {
    await this.connect();
    return (await this.request('thread/read', { threadId: member.sessionId, includeTurns: true })).thread;
  }
  async release(member) {
    if (!this.loaded.has(member.sessionId)) return;
    await this.request('thread/unsubscribe', { threadId: member.sessionId });
    this.loaded.delete(member.sessionId);
  }
  async prepareNative(member) {
    await this.ensureSession(member);
    await this.request('thread/resume', { threadId: member.sessionId, cwd: member.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  }
  async setBinary(binary) {
    const child = this.child;
    if (child) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    this.binary = binary;
  }
  close() { this.child?.kill('SIGTERM'); }
}

export const isActiveWriterError = error => /already has an active writer/i.test(error?.message || '');
export function queuedTurn(thread, clientId) {
  return (thread.turns || []).find(turn => (turn.items || []).some(item => item.type === 'userMessage' && item.clientId === clientId));
}

export async function persistedTurnEnd(path, turnId) {
  if (!path) return null;
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat(), offset = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let status = null;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'event_msg' || event.payload?.turn_id !== turnId) continue;
      if (event.payload.type === 'task_complete') status = 'completed';
      if (event.payload.type === 'turn_aborted') status = 'interrupted';
    }
    return status;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}

export class ClaudeAdapter {
  constructor(binary) { this.binary = binary; this.active = new Map(); }
  async run(member, prompt, { schema, work = false, onDelta, onActivity } = {}) {
    if (!this.binary) throw new Error('找不到 Claude Code，请先安装或配置 AGENT_ROOM_CLAUDE。');
    if (this.active.has(member.id)) throw new Error('这个员工正在工作。');
    const args = ['-p', prompt, '--safe-mode', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    // The first release uses Codex for execution. Claude employees retain their
    // native session and can execute work in Desktop; room turns stay tool-free.
    args.push('--tools', '');
    if (work) throw new Error('Claude 员工的执行工作请在原应用完成。这个版本由 Codex 员工执行主管分工。');
    args.push(member.sessionCreated ? '--resume' : '--session-id', member.sessionId);
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const child = spawn(this.binary, args, { cwd: member.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDECODE: undefined } });
    this.active.set(member.id, child);
    let stderr = '', text = '', result;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    createInterface({ input: child.stdout }).on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'system' && event.subtype === 'init') { member.sessionCreated = true; onActivity?.('正在思考'); }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
        text += event.event.delta.text; if (!schema) onDelta?.(text);
      }
      if (event.type === 'result') result = event;
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, 15 * 60000);
      child.on('error', error => { clearTimeout(timer); this.active.delete(member.id); reject(error); });
      child.on('close', code => {
        clearTimeout(timer); this.active.delete(member.id);
        if (code !== 0 || result?.is_error || !result) return reject(new Error(result?.errors?.join('\n') || result?.result || stderr.trim() || 'Claude 工作已停止或没有返回结果。'));
        member.sessionCreated = true;
        resolve(schema ? result.structured_output || parseStructured(result.result) : result.result || text);
      });
    });
  }
  stop(member) { this.active.get(member.id)?.kill('SIGTERM'); }
  async open(member) {
    if (!member.sessionCreated) throw new Error('请先让这位员工在群里发言，以建立会话。');
    // Claude's Desktop launcher rejects redirected output; script supplies an
    // OS pseudo-terminal without starting an interactive working session.
    if (process.platform !== 'darwin') throw new Error('本地原型的 Claude Desktop 自动打开入口目前支持 macOS。');
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/script', ['-q', '/dev/null', this.binary, '--desktop', '--resume', member.sessionId], { cwd: member.cwd, stdio: ['ignore','pipe','pipe'] });
      let details = ''; const capture = chunk => { details = (details + chunk).slice(-3000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude Desktop 打开超时，请重试。')); },15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) return resolve({ alreadyOpen: false });
        if (/is open in another terminal/i.test(details)) return resolve({ alreadyOpen: true });
        const clean = details.replace(/\u001b\[[0-9;?]*[A-Za-z]/g,'').replace(/[\x00-\x1f]/g,'').replace(/^\^D/,'').trim();
        reject(new Error(`Claude Desktop 打开失败：${clean || '请检查应用是否安装并登录。'}`));
      });
    });
  }
  async transcript(member) {
    // Only search the exact session owned/bound by this employee.
    const projects = join(homedir(), '.claude/projects');
    const directories = await readdir(projects, { withFileTypes: true }).catch(() => []);
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const file = join(projects, directory.name, `${member.sessionId}.jsonl`);
      try {
        const text = await readFile(file, 'utf8');
        const messages = [];
        for (const line of text.split('\n')) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== 'assistant' || event.isSidechain) continue;
          const content = event.message?.content;
          const body = typeof content === 'string' ? content : (content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
          if (body?.trim()) messages.push({ id: event.uuid, text: body });
        }
        return messages;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return [];
  }
  close() { for (const child of this.active.values()) child.kill('SIGTERM'); }
}

export function parseStructured(text) {
  try { return JSON.parse(text); } catch { throw new Error('主管没有返回可识别的分工结果，请重试。'); }
}

export function nativeMessages(thread) {
  return (thread.turns || []).filter(turn => turn.status === 'completed').flatMap(turn =>
    (turn.items || []).filter(item => item.type === 'agentMessage' && item.text?.trim()).map(item => ({ id: `${turn.id}:${item.id}`, text: item.text })));
}
