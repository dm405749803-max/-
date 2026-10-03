import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// Local A-batch demo only. Keep the original 8788 service and its data separate.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const environmentFile = join(root, '.env.dify-a.local');
if (!existsSync(environmentFile)) {
  console.error('缺少本机后端配置 .env.dify-a.local。请先配置专属 Dify 应用；不要把密钥写入前端。');
  process.exit(1);
}

const child = spawn(process.execPath, [
  `--env-file=${environmentFile}`, join(root, 'local-server.mjs')
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    LOCAL_PORT: '8830',
    V2_DATABASE_PATH: join(root, '.local-data', 'a-integration.sqlite'),
    TONGPIN_ENABLE_SIMULATION_KNOWLEDGE: '1'
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('本机验收服务启动失败。');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
