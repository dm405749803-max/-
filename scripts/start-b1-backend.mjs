import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// A separate backend-only process and database. No changes to 8788/8830.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['.env.dify-a.local', '.env.dify-memory.local'].map(name => join(root, name));
const args = files.filter(existsSync).map(path => `--env-file=${path}`);
args.push(join(root, 'local-server.mjs'));
const child = spawn(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    LOCAL_PORT: '8831',
    V2_DATABASE_PATH: join(root, '.local-data', 'b1-backend.sqlite'),
    TONGPIN_ENABLE_BACKEND_B1: '1',
    TONGPIN_BACKEND_ONLY: '1',
    TONGPIN_ENABLE_SIMULATION_KNOWLEDGE: '1'
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('B1 本机后端启动失败。配置内容和密钥不会输出。');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
