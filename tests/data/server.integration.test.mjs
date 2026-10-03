import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function start(database) {
  const child = spawn(process.execPath, ['local-server.mjs'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, LOCAL_PORT: '8822', V2_DATABASE_PATH: database, DIFY_APP_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${diagnostics}`);
    try { const response = await fetch('http://127.0.0.1:8822/api/health'); if (response.ok) return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${diagnostics}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

test('v2 HTTP contract survives restart and rejects concurrent stale update', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-http-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'server.sqlite');
  let child = await start(database); t.after(() => stop(child));
  const request = (path, options = {}) => fetch(`http://127.0.0.1:8822${path}`, { headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo', ...(options.headers || {}) }, ...options });
  let response = await request('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<script src="app\.js"><\/script>/);
  response = await request('/app.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/javascript/);
  assert.match(await response.text(), /const state|function /);

  response = await request('/api/v2/customers', { method: 'POST', body: JSON.stringify({ customer_id: 'http-customer', name: '演练客户' }) });
  assert.equal(response.status, 201);
  const created = await response.json(); assert.equal(created.data.revision, 1); assert.match(created.trace_id, /^[0-9a-f]{32}$/);
  const patches = await Promise.all([
    request('/api/v2/customers/http-customer', { method: 'PATCH', body: JSON.stringify({ expected_revision: 1, changes: { name: '名称 A' } }) }),
    request('/api/v2/customers/http-customer', { method: 'PATCH', body: JSON.stringify({ expected_revision: 1, changes: { name: '名称 B' } }) })
  ]);
  assert.deepEqual(patches.map(item => item.status).sort(), [200, 409]);
  const conflict = await patches.find(item => item.status === 409).json();
  assert.equal(conflict.error.code, 'REVISION_CONFLICT');
  await stop(child);
  child = await start(database);
  response = await request('/api/v2/customers/http-customer');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.revision, 2);
  response = await request('/api/v2/opportunities/missing/drafts', { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'OPPORTUNITY_NOT_FOUND');
});
