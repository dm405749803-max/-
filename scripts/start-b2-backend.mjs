import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// Isolated backend: do not alter the original demos or their databases.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['.env.dify-a.local', '.env.dify-memory.local', '.env.dify-match.local'].map(name => join(root, name));
const child = spawn(process.execPath, [...files.filter(existsSync).map(path => `--env-file=${path}`), join(root, 'local-server.mjs')], {
  cwd: root, stdio: 'inherit',
  env: {
    ...process.env, LOCAL_PORT: '8832', V2_DATABASE_PATH: join(root, '.local-data', 'b2-backend.sqlite'),
    TONGPIN_ENABLE_BACKEND_B1: '1', TONGPIN_ENABLE_BACKEND_B2: '1', TONGPIN_BACKEND_ONLY: '1',
    TONGPIN_ENABLE_SIMULATION_KNOWLEDGE: '1'
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('B2 本机后端未能启动，未输出配置内容。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
