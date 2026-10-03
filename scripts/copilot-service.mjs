import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const root = dirname(dirname(entry));
const logs = join(homedir(), 'Library', 'Logs', 'Yihuoyicheng');
const pidFile = join(root, '.local-data', 'copilot-service.pid');
const command = process.argv[2] || 'start';
const url = 'http://127.0.0.1:8834/sales-copilot.html';
function managedPid() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid < 2) return null;
    const args = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return args.includes(entry) && args.includes('--serve') ? pid : null;
  } catch { return null; }
}
async function health() {
  try {
    const response = await fetch('http://127.0.0.1:8834/api/health', { signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    return response.ok && value.ok === true && value.v2_database === 'ready';
  } catch { return false; }
}
if (command === '--serve') {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  let child, closing = false, retry;
  const start = () => {
    child = spawn(process.execPath, [join(root, 'scripts/start-integrated-workbench.mjs')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, LOCAL_PORT: '8834' }
    });
    child.once('error', () => console.error('副驾进程启动失败，请检查运行环境。'));
    child.once('exit', () => {
      if (closing) process.exit(0);
      console.error('副驾进程已退出，10秒后尝试恢复。');
      retry = setTimeout(start, 10000);
    });
  };
  const stop = () => {
    closing = true; clearTimeout(retry);
    if (child && child.exitCode === null) child.kill('SIGTERM');
    else process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('exit', () => { try { if (Number(readFileSync(pidFile, 'utf8')) === process.pid) rmSync(pidFile); } catch {} });
  start();
} else {
  try {
    if (command === 'status') console.log(JSON.stringify({ pid: managedPid(), healthy: await health(), url }));
    else if (command === 'stop') {
      const pid = managedPid();
      if (pid) process.kill(pid, 'SIGTERM');
      console.log(pid ? '后台服务正在停止；数据保留。' : '没有本脚本管理的后台服务。');
    } else if (command === 'start') {
      let pid = managedPid();
      if (!pid && await health()) throw new Error('8834已有其他服务，未自动终止；请先确认进程。');
      if (!pid) {
        mkdirSync(logs, { recursive: true, mode: 0o700 });
        const out = openSync(join(logs, 'sales-copilot.log'), 'a', 0o600);
        const err = openSync(join(logs, 'sales-copilot.error.log'), 'a', 0o600);
        const processHandle = spawn(process.execPath, [entry, '--serve'], { detached: true, cwd: root, stdio: ['ignore', out, err], env: process.env });
        processHandle.unref(); closeSync(out); closeSync(err); pid = processHandle.pid;
      }
      let ready = false;
      for (let i = 0; i < 30; i++) {
        if (await health()) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!ready) throw new Error(`服务尚未就绪，请检查 ${logs} 中的日志。`);
      console.log(JSON.stringify({ pid: managedPid() || pid, healthy: true, restartOnExit: true, url }));
    } else throw new Error('用法：node scripts/copilot-service.mjs start|status|stop');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
