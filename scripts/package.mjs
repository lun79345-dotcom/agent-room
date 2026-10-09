import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../lib/environment.mjs';

const exec = promisify(execFile);
export const RELEASE_FILES = [
  'package.json', 'README.md', 'README.en.md', 'docs/agent-room-overview.svg', '开始使用.html', '内测说明.md',
  '启动员工群.command', '重新启动群聊.command', '停止员工群.command',
  'server.mjs', 'launch.mjs', 'control.mjs',
  'lib/adapters.mjs', 'lib/store.mjs', 'lib/environment.mjs', 'lib/failures.mjs',
  'public/index.html', 'public/app.js', 'public/style.css',
  'test/coordination.test.mjs', 'test/beta.test.mjs', 'scripts/package.mjs',
];
export async function buildRelease(root, output = join(root, 'release')) {
  const temp = await mkdtemp(join(tmpdir(), 'agent-room-release-'));
  const directoryName = 'Agent Room Mac 内测版';
  const stage = join(temp, directoryName);
  try {
    await mkdir(stage);
    const files = [];
    for (const relative of RELEASE_FILES) {
      const source = join(root, relative), destination = join(stage, relative);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`发布文件不应是链接或目录：${relative}`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination); await chmod(destination, relative.endsWith('.command') ? 0o755 : 0o644);
      files.push({ path: relative, sha256: createHash('sha256').update(await readFile(destination)).digest('hex') });
    }
    await writeFile(join(stage, 'release-manifest.json'), JSON.stringify({ version: APP_VERSION, platform: 'macOS', files }, null, 2));
    await mkdir(output, { recursive: true });
    const archive = join(output, `agent-room-mac-beta-${APP_VERSION}.zip`);
    await exec('/usr/bin/ditto', ['-c','-k','--keepParent','--norsrc',stage,archive]);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(join(output, 'SHA256.txt'), `${sha256}  agent-room-mac-beta-${APP_VERSION}.zip\n`);
    return archive;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(await buildRelease(dirname(dirname(fileURLToPath(import.meta.url))))); }
  catch (error) { console.error('内测包生成失败：' + error.message); process.exitCode = 1; }
}
