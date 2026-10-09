const $ = selector => document.querySelector(selector);
let room, mode = 'discussion', recipient = 'manager', sending = false, renderKey = '', setupAutoShown = false, programDirty = false;
const esc = text => String(text ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[x]));
const busy = member => ['working','thinking','connecting'].includes(member.status);
const color = member => ['clay','green','blue'].includes(member?.color) ? member.color : 'green';
const statusText = member => ({ thinking: '思考中', working: '工作中', connecting: '正在打开', error: '需要处理' }[member.status] || (member.location === 'native' ? member.provider === 'codex' ? '原应用 · 可联系' : '原应用中' : '可联系'));
const taskText = status => ({ working: '进行中', completed: '已完成', failed: '未完成', interrupted: '已中断' }[status] || status);
const avatar = (member, size = '') => `<span class="avatar ${color(member)} ${size}">${member?.provider === 'claude' ? '✳' : '⌘'}</span>`;
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 5000);
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': room.csrf }, body: JSON.stringify(body || {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作未完成。'); return data;
}
function setMode(value) {
  mode = value; $('#mode-discuss').classList.toggle('selected', mode === 'discussion'); $('#mode-work').classList.toggle('selected', mode === 'work');
  if (mode === 'work') recipient = room?.members.find(m => m.role === 'manager' && m.provider === 'claude')?.id || '';
  renderRecipients();
  $('#message-input').placeholder = mode === 'work' ? '告诉主管要完成的工作、要求和验收标准…' : '和主管讨论需求，或 @ 一位员工跟进进度…';
  $('#composer-hint').textContent = mode === 'work' ? '主管将分配并执行任务 · Enter 交办' : '本模式只讨论 · 执行任务请选“交办工作”';
  $('#send').innerHTML = mode === 'work' ? '交办 <span>↗</span>' : '发送 <span>↑</span>';
}
function renderRecipients() {
  if (!room) return;
  const options = mode === 'work' ? room.members.filter(m => m.role === 'manager' && m.provider === 'claude') : room.members;
  const choices = options.map(m => [m.id, `@${m.name}`]);
  if (mode === 'discussion') choices.push(['all', '@所有员工'], ['none', '仅记录消息']);
  if (!choices.some(x => x[0] === recipient)) recipient = choices[0]?.[0] || '';
  $('#recipients').innerHTML = choices.map(([id,name]) => `<option value="${esc(id)}" ${id === recipient ? 'selected' : ''}>${esc(name)}</option>`).join('');
}
function renderState(next) {
  room = next;
  renderEnvironment();
  const n = room.members.length;
  $('#sidebar-count').textContent = `你和 ${n} 位员工`; $('#room-subtitle').textContent = `${n + 1} 人 · 每位员工都有自己的工作会话`;
  $('#member-count').textContent = n; $('#task-count').textContent = room.tasks.length;
  $('.tasks-heading>span').textContent = room.tasks.length ? `${room.tasks.filter(t => t.status === 'completed').length} 已完成 · ${room.tasks.filter(t => t.status === 'working').length} 进行中` : '主管分工后显示';
  $('#connections').innerHTML = ['claude','codex'].map(kind => `<div class="connection-row"><span><i class="${room.connections[kind]?.ready ? 'ready' : ''}"></i>${kind === 'claude' ? 'Claude' : 'Codex'}</span><small>${esc(room.connections[kind]?.detail || '未连接')}</small></div>`).join('');
  $('#staff-nav').innerHTML = room.members.map(m => `<button class="staff-nav-item" data-contact="${esc(m.id)}">${avatar(m, 'tiny')}<span>${esc(m.name)}<small>${m.role === 'manager' ? '主管' : '员工'}</small></span><i class="presence ${busy(m) ? 'working' : m.location === 'native' ? 'native' : m.status === 'error' ? 'error' : ''}"></i></button>`).join('');
  $('#team-strip').innerHTML = `<div class="strip-person"><span class="avatar user tiny">你</span><span>确定方向</span></div><span class="strip-arrow">→</span>` + room.members.map(m => `<button class="strip-person" data-contact="${esc(m.id)}">${avatar(m, 'tiny')}<span>${esc(m.name)}<small>${m.role === 'manager' ? '分工 · 跟进 · 汇报' : esc(m.responsibility.slice(0,20))}</small></span></button>`).join('<span class="strip-divider">/</span>');
  $('#staff-cards').innerHTML = room.members.map(m => {
    const native = m.location === 'native';
    return `<article class="staff-card ${color(m)}"><div class="staff-card-top">${avatar(m)}<div><strong>${esc(m.name)}</strong><small>${m.provider === 'claude' ? 'Claude' : 'Codex'} · ${m.role === 'manager' ? '主管' : '员工'}</small></div><button class="icon-button light" data-edit="${esc(m.id)}" aria-label="编辑 ${esc(m.name)}">···</button></div><p>${esc(m.responsibility)}</p><div class="staff-state"><span class="status-pill ${busy(m) ? 'working' : m.status === 'error' ? 'error' : native ? 'native' : ''}"><i></i>${statusText(m)}</span><span class="session-label" title="${esc(m.sessionId || '')}">${m.sessionId && (m.provider === 'codex' || m.sessionCreated) ? '会话已绑定' : '首次发言时建立'}</span></div>${m.syncError ? `<small class="staff-error">进度同步失败：${esc(m.syncError)}</small>` : m.error ? `<small class="staff-error">${esc(m.error.slice(0,180))}</small>` : busy(m) && m.activity ? `<small class="staff-activity">${esc(m.activity)}</small>` : ''}<div class="staff-actions"><button class="button compact" data-contact="${esc(m.id)}">@ 联系</button>${busy(m) ? `<button class="button compact" data-stop="${esc(m.id)}">停止</button>` : native ? `<button class="button compact native-button" data-return="${esc(m.id)}">回群聊 ↙</button>` : `<button class="button compact native-button" data-open="${esc(m.id)}">去 ${m.provider === 'claude' ? 'Claude' : 'Codex'} 工作 ↗</button>`}</div></article>`;
  }).join('');
  $('#tasks').innerHTML = room.tasks.length ? room.tasks.slice().reverse().map(t => `<button class="task-card" data-task="${esc(t.id)}"><div><span class="task-indicator ${esc(t.status)}">${t.status === 'completed' ? '✓' : t.status === 'working' ? '◌' : '!'}</span><strong>${esc(t.title)}</strong></div><p>${esc(room.members.find(m => m.id === t.employeeId)?.name || '已离组员工')}<span class="task-status ${esc(t.status)}">${taskText(t.status)}</span></p></button>`).join('') : `<div class="empty-tasks"><span>▤</span><p>还没有交办的工作</p><small>选择“交办工作”，由主管安排。</small></div>`;
  renderRecipients(); renderMessages();
  $('#send').disabled = sending || !recipient || (mode === 'work' && room.dispatching);
}
function renderEnvironment() {
  const env = room.environment, checking = room.environmentChecking;
  $('#recheck-setup').disabled = checking;
  $('#recheck-setup').textContent = checking ? '检查中…' : '重新检查';
  const banner = $('#setup-banner');
  banner.hidden = !env || env.ready;
  banner.textContent = env && !env.ready ? '使用环境需要处理。点击“使用前检查”查看缺少的程序、登录或工作目录。' : '';
  $('#setup-summary').textContent = checking ? '正在检查本机安装与登录…' : env?.error || (env?.ready ? '群聊环境已准备好' : env ? '还有几项需要处理' : '等待首次检查');
  $('#setup-summary').className = env?.ready ? 'setup-summary ready' : 'setup-summary';
  if (!env?.providers) { $('#setup-checks').innerHTML = ''; return; }
  const row = (title, ready, text, action = '', url = '') => `<article class="env-check"><div><span class="env-indicator ${ready ? 'ready' : ''}">${ready ? '✓' : '!'}</span><strong>${esc(title)}</strong><small>${ready ? '已就绪' : '需要处理'}</small></div><p>${esc(text)}</p>${action ? `<p class="env-action">${esc(action)}</p>` : ''}${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">安装与登录说明 ↗</a>` : ''}</article>`;
  const rows = [row('Mac 与运行环境', env.platform?.ready && env.runtime?.ready, `${env.platform?.name || ''} · Node.js ${env.runtime?.version || ''}`, env.runtime?.ready ? env.platform?.ready ? '' : '本内测版支持 macOS。' : '安装 Node.js 22 或更高版本。')];
  for (const kind of ['claude','codex']) {
    const item = env.providers[kind];
    rows.push(row(kind === 'claude' ? 'Claude Code' : 'Codex', item.ready, [item.version, item.detail].filter(Boolean).join(' · '), item.action, item.ready ? '' : item.helpUrl));
  }
  rows.push(row('回到原应用工作', env.native?.codex && env.native?.claude, `Codex 入口${env.native?.codex ? '可用' : '未就绪'} · Claude 入口${env.native?.claude ? '可用' : '未就绪'}`, 'Claude 在原应用中工作时，完成后需回群聊继续管理。'));
  rows.push(row('工作目录', env.directories?.every(d => d.ready), env.directories?.every(d => d.ready) ? '员工的工作目录存在且可读写。' : '部分员工目录不存在或不可写。', env.directories?.every(d => d.ready) ? '' : '关闭本窗口后，在员工设置中调整工作目录。'));
  $('#setup-checks').innerHTML = rows.join('') + (env.warnings || []).map(text => `<p class="env-warning">${esc(text)}</p>`).join('');
  if (!programDirty) for (const key of ['claudeBinary','codexBinary']) $('#program-form').elements[key].value = env.settings?.[key] || '';
  if (!env.ready && !setupAutoShown) { setupAutoShown = true; $('#setup-dialog').showModal(); }
}
function renderMessages() {
  const key = JSON.stringify(room.messages);
  if (key === renderKey) return; renderKey = key;
  const area = $('#message-area'), nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150;
  $('#welcome').hidden = room.messages.some(m => m.sender === 'user');
  $('#messages').innerHTML = room.messages.map(m => {
    if (m.sender === 'system') return `<div class="notice ${m.error ? 'error' : ''}"><span>${m.error ? '!' : '✳'}</span>${esc(m.text)}</div>`;
    const member = room.members.find(x => x.id === m.sender);
    const isUser = m.sender === 'user'; const name = isUser ? '你' : member?.name || m.senderName || '已离组员工';
    const time = new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const recipients = (m.recipients || []).map(id => room.members.find(x => x.id === id)?.name || '').filter(Boolean);
    return `<article class="message ${isUser ? 'user-message' : ''} ${m.error ? 'error-message' : ''}">${isUser ? '<span class="avatar user">你</span>' : avatar(member)}<div class="message-content"><div class="message-meta"><strong>${esc(name)}</strong>${!isUser ? `<span class="role-tag">${member?.role === 'manager' ? '主管' : '员工'}</span>` : ''}${m.kind === 'native' || m.source === '原应用' ? '<span class="source-tag">来自原应用</span>' : m.kind === 'request' ? '<span class="source-tag">交办工作</span>' : m.kind === 'result' ? '<span class="source-tag">工作结果</span>' : ''}<time>${time}</time></div>${recipients.length ? `<div class="message-mentions">${recipients.map(n => `<span>@${esc(n)}</span>`).join(' ')}</div>` : ''}<div class="message-body">${m.text ? formatText(m.text) : m.pending ? '<span class="thinking-dots"><i></i><i></i><i></i></span>' : ''}${m.pending && m.text ? '<span class="typing-caret"></span>' : ''}${m.error && m.failure?.retryable && m.retryRequest ? `<button class="button compact retry-reply" data-retry="${esc(m.id)}">再联系一次 ↻</button>` : ''}</div></div></article>`;
  }).join('');
  if (nearBottom || room.messages.at(-1)?.sender === 'user') requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}
function formatText(text) {
  // Render only escaped text and a small formatting subset, never agent HTML.
  const inline = part => esc(part)
    .replace(/\[([^\]]+)\]\((?:&lt;)?([^\)]+?)(?:&gt;)?\)/g, (_, label, url) => /^https?:\/\//i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<span class="file-reference" title="${url}">${label}</span>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  const blocks = String(text).split(/```/);
  return blocks.map((part,index) => {
    if (index % 2) return `<pre><code>${esc(part.replace(/^[a-zA-Z0-9_-]*\n/, ''))}</code></pre>`;
    const lines = part.split('\n'), output = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\|/.test(line) && /^\|[\s:|\-]+\|\s*$/.test(lines[i+1] || '')) {
        const cells = value => value.trim().replace(/^\||\|$/g,'').split('|').map(x => x.trim());
        const headers = cells(line); i += 2; const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        i--;
        output.push(`<div class="message-table"><table><thead><tr>${headers.map(x => `<th>${inline(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (/^#{1,6}\s/.test(line)) output.push(`<h4>${inline(line.replace(/^#{1,6}\s+/,''))}</h4>`);
      else if (/^[-*]\s/.test(line)) output.push(`<div class="message-list-item"><span>•</span><div>${inline(line.slice(2))}</div></div>`);
      else output.push(line ? inline(line) + '<br>' : '<div class="paragraph-gap"></div>');
    }
    return output.join('');
  }).join('');
}
async function sendMessage(text, to = recipient, nextMode = mode) {
  if (sending) return;
  if (!text.trim()) { $('#message-input').focus(); return; }
  sending = true; $('#send').disabled = true;
  try {
    await api('messages', { text, mode: nextMode, recipients: to === 'all' ? 'all' : to === 'none' ? [] : [to] });
    $('#message-input').value = ''; $('#message-input').style.height = '';
  } catch (error) { toast(error.message); }
  finally { sending = false; $('#send').disabled = mode === 'work' && room.dispatching; }
}
$('#composer').addEventListener('submit', event => { event.preventDefault(); sendMessage($('#message-input').value); });
$('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(event.currentTarget.value); } });
$('#message-input').addEventListener('input', event => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(180, event.currentTarget.scrollHeight)}px`; });
$('#mode-discuss').onclick = () => setMode('discussion'); $('#mode-work').onclick = () => setMode('work');
$('#recipients').onchange = event => { recipient = event.target.value; };
$('#introduce').onclick = () => sendMessage('请大家分别介绍自己负责的工作，并确认后续会沿用各自的固定会话。', 'all', 'discussion');
$('#start-task').onclick = () => { setMode('work'); $('#message-input').focus(); };
$('#get-report').onclick = () => { const manager = room.members.find(m => m.role === 'manager'); if (!manager) return toast('请先添加一位主管。'); sendMessage('请根据真实任务记录向我汇报当前进度，没有工作结果时请直接说明。', manager.id, 'discussion'); };
$('#sync-native').onclick = async () => { try { await api('sync'); toast('已同步原应用中的新回复。'); } catch (error) { toast(error.message); } };
$('#refresh-connections').onclick = async () => { try { await api('connections'); toast('应用连接已更新。'); } catch (error) { toast(error.message); } };
$('#open-setup').onclick = () => $('#setup-dialog').showModal();
$('#close-setup').onclick = $('#finish-setup').onclick = () => $('#setup-dialog').close();
$('#recheck-setup').onclick = async () => { try { await api('connections'); toast('使用环境检查完成。'); } catch (error) { toast(error.message); } };
$('#program-form').addEventListener('input', () => { programDirty = true; });
$('#program-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; $('#program-error').textContent = '';
  try { await api('settings', Object.fromEntries(new FormData(event.currentTarget))); programDirty = false; renderEnvironment(); toast('本机程序位置已保存。'); }
  catch (error) { $('#program-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#toggle-team').onclick = () => $('#team-panel').classList.toggle('visible');

function editMember(member) {
  const form = $('#member-form'); form.reset(); $('#member-error').textContent = '';
  $('#dialog-title').textContent = member ? '员工设置' : '添加员工'; $('#remove-member').hidden = !member;
  const values = member || { provider: 'codex', role: 'worker', cwd: room.members[0]?.cwd || '' };
  for (const name of ['id','name','provider','role','cwd','responsibility','sessionId']) form.elements[name].value = values[name] || '';
  $('#member-dialog').showModal();
}
$('#add-member').onclick = $('#panel-add').onclick = () => editMember();
$('#close-dialog').onclick = () => $('#member-dialog').close();
$('#member-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { await api('member', Object.fromEntries(new FormData(form))); $('#member-dialog').close(); toast('员工设置已保存。'); }
  catch (error) { $('#member-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#member-form').elements.role.onchange = event => { if (event.target.value === 'manager') $('#member-form').elements.provider.value = 'claude'; };
$('#remove-member').onclick = async () => { try { await api('remove', { id: $('#member-form').elements.id.value }); $('#member-dialog').close(); toast('员工已移出小组，原会话保留。'); } catch (error) { $('#member-error').textContent = error.message; } };
$('#close-task').onclick = () => $('#task-dialog').close();
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-contact],[data-edit],[data-open],[data-return],[data-stop],[data-task],[data-retry],[data-retry-task]'); if (!button) return;
  if (button.dataset.contact) { setMode('discussion'); recipient = button.dataset.contact; renderRecipients(); $('#message-input').focus(); return; }
  if (button.dataset.edit) { editMember(room.members.find(m => m.id === button.dataset.edit)); return; }
  if (button.dataset.task) {
    const task = room.tasks.find(t => t.id === button.dataset.task); $('#task-title').textContent = task.title;
    $('#task-detail').innerHTML = `<div class="task-detail-meta">${esc(room.members.find(m => m.id === task.employeeId)?.name || '已离组员工')} · ${taskText(task.status)}</div><h3>工作要求</h3><div class="message-body">${formatText(task.instructions)}</div>${task.result ? `<h3>工作结果</h3><div class="message-body">${formatText(task.result)}</div>` : task.error ? `<h3>未完成原因</h3><p class="form-error">${esc(task.error)}</p>` : '<p>员工正在工作，结果会回到群聊。</p>'}${['failed','interrupted'].includes(task.status) ? `<p class="setup-note">继续前，员工会先核对已有成果，避免重复操作。</p><button class="button primary" data-retry-task="${esc(task.id)}">继续这项任务 ↻</button>` : ''}`;
    $('#task-dialog').showModal(); return;
  }
  button.disabled = true;
  try {
    if (button.dataset.retry) { await api('retry', { id: button.dataset.retry }); toast('正在联系同一位员工的原会话。'); }
    else if (button.dataset.retryTask) { await api('retry-task', { id: button.dataset.retryTask }); $('#task-dialog').close(); toast('已请求核对成果后继续原任务。'); }
    else if (button.dataset.open) {
      const result = await api('open', { id: button.dataset.open });
      if (result.url) { const link = document.createElement('a'); link.href = result.url; link.click(); }
      toast(result.alreadyOpen ? '这位员工的会话已在原应用或终端打开，请切到该会话继续。' : '已切换到原应用。Codex 员工仍可从群聊联系。');
    } else if (button.dataset.return) { await api('return', { id: button.dataset.return }); toast('可以从群聊联系，仍使用同一个会话。'); }
    else if (button.dataset.stop) { await api('stop', { id: button.dataset.stop }); toast('已请求停止当前工作。'); }
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

try {
  const response = await fetch('/api/state'); if (!response.ok) throw new Error('本地服务未连接。'); renderState(await response.json()); setMode('discussion');
  const events = new EventSource('/api/events');
  events.addEventListener('state', event => { renderState(JSON.parse(event.data)); $('#live-status').innerHTML = '<i></i>本地已连接'; $('#live-status').classList.remove('offline'); });
  events.onerror = () => { $('#live-status').innerHTML = '<i></i>连接中断，正在重连'; $('#live-status').classList.add('offline'); };
} catch (error) { toast(error.message); $('#live-status').textContent = '服务未连接'; }
