import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['.env.dify-a.local', '.env.dify-memory.local', '.env.dify-match.local', '.env.asr.local'].map(name => join(root, name));
const child = spawn(process.execPath, [...files.filter(existsSync).map(path => `--env-file=${path}`), join(root, 'local-server.mjs')], {
  cwd: root, stdio: 'inherit',
  env: {
    ...process.env, LOCAL_PORT: process.env.LOCAL_PORT || '8833',
    V2_DATABASE_PATH: join(root, '.local-data', 'b2-backend.sqlite'),
    TONGPIN_ENABLE_BACKEND_B1: '1', TONGPIN_ENABLE_BACKEND_B2: '1',
    TONGPIN_BACKEND_ONLY: '0', TONGPIN_ENABLE_SIMULATION_KNOWLEDGE: '1'
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('本机一体化工作台未能启动。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
