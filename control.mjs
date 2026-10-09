import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { health, launch, matchingInstance, root } from './launch.mjs';

try {
  const mode = process.argv[2];
  if (!['stop','restart'].includes(mode)) throw new Error('请选择停止或重新启动。');
  let runtime;
  try { runtime = JSON.parse(await readFile(join(root, '.data/runtime.json'), 'utf8')); } catch {}
  if (runtime) {
    const info = await health(runtime.port);
    if (matchingInstance(info)) {
      if (info.busy) throw new Error('当前仍有工作正在进行，请先完成或在群聊中停止这一轮。');
      const url = `http://127.0.0.1:${runtime.port}`;
      const state = await (await fetch(url + '/api/state', { signal: AbortSignal.timeout(3000) })).json();
      const response = await fetch(url + '/api/shutdown', { method: 'POST', headers: { 'content-type':'application/json', 'x-room-token':state.csrf }, body:'{}', signal:AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error((await response.json()).error || '服务未能停止。');
      for (let attempt = 0; attempt < 30 && matchingInstance(await health(runtime.port)); attempt++) await delay(100);
      if (matchingInstance(await health(runtime.port))) throw new Error('服务仍在保存数据，请稍后重新启动。');
    }
  }
  console.log(mode === 'restart' ? await launch() : '员工群后台服务已停止；原应用会话和聊天记录仍保留。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
