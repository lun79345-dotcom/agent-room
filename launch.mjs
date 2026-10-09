import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { appIdentity } from './lib/environment.mjs';

export const root = dirname(fileURLToPath(import.meta.url));
export async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
export async function portAvailable(port) {
  return await new Promise(resolve => {
    const probe = createServer(); probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
export function matchingInstance(info, directory = root) {
  const app = appIdentity(directory);
  return info?.app?.id === app.id && info.app.workspaceId === app.workspaceId;
}
export async function launch() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更高版本，请先打开“开始使用.html”安装。');
  let saved;
  try { saved = JSON.parse(await readFile(join(root, '.data/runtime.json'), 'utf8')); } catch {}
  const explicit = process.env.AGENT_ROOM_PORT;
  if (explicit && (!/^\d+$/.test(explicit) || Number(explicit) < 1024 || Number(explicit) > 65535)) throw new Error('端口需要是 1024–65535 之间的整数。');
  const ports = explicit ? [Number(explicit)] : [...new Set([saved?.port, ...Array.from({ length: 20 }, (_, i) => 4319 + i)].filter(p => Number.isInteger(p) && p >= 1024 && p <= 65535))];
  for (const port of ports) {
    const existing = await health(port);
    if (matchingInstance(existing)) {
      if (existing.app.version !== appIdentity(root).version) throw new Error('当前文件夹仍有旧版服务运行，请等工作结束后双击“重新启动群聊.command”。');
      await writeRuntime(port, saved?.pid); return `http://127.0.0.1:${port}`;
    }
    if (!await portAvailable(port)) continue;
    await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
    const log = openSync(join(root, '.data/server.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, AGENT_ROOM_PORT: String(port) } });
    let spawnError; child.once('error', error => { spawnError = error; });
    child.unref(); closeSync(log);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw new Error('后台服务未能启动，请检查 Node.js 安装。');
      const result = await health(port);
      if (matchingInstance(result)) { await writeRuntime(port, child.pid); return `http://127.0.0.1:${port}`; }
      await delay(250);
    }
    throw new Error('群聊未能启动，请查看 .data/server.log 或重新启动。');
  }
  throw new Error('可用端口已占用，请关闭其他员工群副本后重新启动。');
}
async function writeRuntime(port, pid) {
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.data/runtime.json'), JSON.stringify({ port, pid, app: appIdentity(root) }), { mode: 0o600 });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(await launch()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
