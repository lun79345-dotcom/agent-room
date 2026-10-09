import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { findBinary, checkConnection } from './adapters.mjs';

const exec = promisify(execFile);
export const APP_VERSION = '0.2.0';
export const appIdentity = root => ({ id: 'agent-room', version: APP_VERSION, workspaceId: createHash('sha256').update(root).digest('hex').slice(0, 24) });
export const HELP = {
  node: 'https://nodejs.org/en/download',
  codex: 'https://learn.chatgpt.com/docs/cli',
  claude: 'https://code.claude.com/docs/en/setup',
  claudeDesktop: 'https://claude.com/download',
  codexDesktop: 'https://learn.chatgpt.com/docs/app',
};
export async function loadSettings(root) {
  try { return JSON.parse(await readFile(join(root, '.data/settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('本机程序配置无法读取，请检查 .data/settings.json。'); }
}
export async function saveSettings(root, input) {
  const settings = {};
  for (const key of ['codexBinary', 'claudeBinary']) {
    const value = String(input[key] || '').trim();
    if (value && (!isAbsolute(value) || value.length > 4096)) throw new Error('程序位置需要填写完整文件路径。');
    if (value) {
      try { await access(value, constants.X_OK); }
      catch { throw new Error('这个程序不存在或无法运行，请重新选择程序位置。'); }
      settings[key] = value;
    }
  }
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  const file = join(root, '.data/settings.json');
  await writeFile(file + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(file + '.tmp', file); return settings;
}
export function claudeFeatures(help) {
  const flags = ['--safe-mode', '--output-format', '--include-partial-messages', '--json-schema', '--resume', '--session-id', '--tools'];
  return { room: flags.every(flag => help.includes(flag)), desktop: help.includes('--desktop'), missing: flags.filter(flag => !help.includes(flag)) };
}
async function schemaFeatures(binary) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-room-capabilities-'));
  try {
    await exec(binary, ['app-server', 'generate-json-schema', '--out', dir, '--experimental'], { timeout: 15000, maxBuffer: 100000 });
    const exists = async name => { try { await access(join(dir, 'v2', name + '.json')); return true; } catch { return false; } };
    return { room: await exists('TurnStartParams'), queue: (await Promise.all(['ThreadQueueAddParams','ThreadQueueListParams','ThreadQueueDeleteParams','ThreadQueueStartParams'].map(exists))).every(Boolean) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function installedApp(names) {
  for (const folder of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of names) { try { await access(join(folder, name)); return true; } catch {} }
  }
  return false;
}
export async function inspectProvider(kind, binary, { execute = exec, authenticate = checkConnection, inspectSchema = schemaFeatures } = {}) {
  if (!binary) return { installed: false, ready: false, detail: '需要安装', action: `安装 ${kind === 'claude' ? 'Claude Code' : 'Codex CLI'} 后，点击重新检查。`, helpUrl: HELP[kind] };
  let version;
  try { version = (await execute(binary, ['--version'], { timeout: 10000, maxBuffer: 100000 })).stdout.trim().slice(0, 120); }
  catch { return { installed: true, ready: false, detail: '程序无法运行', action: '检查安装是否完整；已安装时可在下方手动填写程序位置。', helpUrl: HELP[kind] }; }
  if (!(kind === 'claude' ? /claude|^\d+\.\d+\.\d+/i : /codex/i).test(version)) return { installed: true, ready: false, detail: '程序位置不正确', action: '请填写对应 Claude Code 或 Codex 的程序位置。', helpUrl: HELP[kind] };
  const checks = await Promise.allSettled([
    authenticate(kind, binary),
    kind === 'claude' ? execute(binary, ['--help'], { timeout: 10000, maxBuffer: 100000 }).then(r => claudeFeatures(r.stdout)) : inspectSchema(binary),
  ]);
  const auth = checks[0].status === 'fulfilled' ? checks[0].value : { ready: false };
  const features = checks[1].status === 'fulfilled' ? checks[1].value : { room: false };
  return {
    installed: true, version, authenticated: Boolean(auth.ready), features,
    ready: Boolean(auth.ready && features.room),
    detail: !features.room ? '需要兼容版本' : auth.ready ? '使用现有登录' : '需要登录',
    action: !features.room ? '当前版本缺少群聊接口，请安装兼容版本后重新检查。' : !auth.ready ? `在 ${kind === 'claude' ? 'Claude Code' : 'Codex CLI'} 中完成登录，然后重新检查。桌面应用登录不一定等于 CLI 已登录。` : '',
    helpUrl: HELP[kind],
  };
}
export async function checkDirectories(members) {
  return await Promise.all([...new Set(members.map(m => m.cwd))].map(async path => {
    try { if (!(await stat(path)).isDirectory()) throw new Error(); await access(path, constants.R_OK | constants.W_OK); return { path, ready: true }; }
    catch { return { path, ready: false, action: '在员工设置中选择存在且可读写的项目文件夹。' }; }
  }));
}
export async function inspectEnvironment(root, members) {
  const settings = await loadSettings(root);
  const paths = Object.fromEntries(await Promise.all(['codex','claude'].map(async kind => [kind, await findBinary(kind, root, settings)])));
  const [codex, claude, directories, codexDesktop, claudeDesktop] = await Promise.all([
    inspectProvider('codex', paths.codex), inspectProvider('claude', paths.claude), checkDirectories(members),
    installedApp(['Codex.app','ChatGPT.app']), installedApp(['Claude.app']),
  ]);
  const runtime = { ready: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node };
  const platform = { ready: process.platform === 'darwin', name: process.platform === 'darwin' ? 'macOS' : process.platform };
  const native = { codex: Boolean(codexDesktop && codex.features?.queue), claude: Boolean(claudeDesktop && claude.features?.desktop && platform.ready) };
  const warnings = [];
  if (codex.ready && !codex.features?.queue) warnings.push('Codex 群聊可用，但当前版本不支持向原应用投递消息。需要升级到支持消息队列的版本。');
  if (!codexDesktop) warnings.push('未找到 Codex 桌面应用；群聊可以使用已安装 CLI，原应用入口暂不可用。');
  if (!claudeDesktop || !claude.features?.desktop) warnings.push('Claude 原应用入口暂不可用，需要 Claude Desktop 和支持打开原会话的 Claude Code。');
  return {
    checkedAt: new Date().toISOString(), ready: platform.ready && runtime.ready && codex.ready && claude.ready && directories.every(d => d.ready),
    runtime, platform, providers: { codex, claude }, native, warnings, directories,
    settings: { codexBinary: paths.codex || '', claudeBinary: paths.claude || '' },
    // Authentication inspection is local; it does not spend model quota or
    // establish that remote model services are reachable.
    networkVerified: false,
  };
}
