import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function start(t, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-b1-http-'));
  const child = spawn(process.execPath, ['local-server.mjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, LOCAL_PORT: '0', V2_DATABASE_PATH: join(directory, 'test.sqlite'),
      TONGPIN_ENABLE_BACKEND_B1: enabled ? '1' : '0', TONGPIN_BACKEND_ONLY: '1',
      DIFY_APP_API_KEY: '', DIFY_MEMORY_APP_API_KEY: ''
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Isolated B1 test service did not start.')), 5000);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      stdout += data;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Isolated B1 test service exited: ${stderr.slice(0, 1600)}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const request = async (path, method = 'GET', body, workspace = 'b1-test') => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-workspace-id': workspace },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, body: await response.json() };
  };
  return request;
}

test('B1 backend routes are explicitly enabled, isolated and truthful when memory Dify is absent', async t => {
  const request = await start(t);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.backend_b1_enabled, true);
  assert.equal(health.body.backend_only, true);
  assert.equal(health.body.dify_configured, false);
  assert.equal(health.body.memory_workflow_configured, false);
  // A backend-only process does not serve or mutate the old frontend state.
  for (const path of ['/', '/app.js', '/api/state']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/api/state', 'PUT', { fake: true })).status, 404);
  const create = await request('/api/v2/customers', 'POST', { customer_id: 'b1-customer', name: '后端联调演练客户' });
  assert.equal(create.status, 201);
  assert.equal((await request('/api/v2/customers/b1-customer/opportunities', 'POST', {
    opportunity_id: 'b1-need', environment: 'simulation', product_id: 'fixture-product', product_version: 'fixture-v1'
  })).status, 201);
  assert.equal((await request('/api/v2/opportunities/b1-need/messages', 'POST', {
    idempotency_key: 'b1-message', role: 'customer', status: 'received', source: 'simulation', environment: 'simulation', text: '我想了解交费方式。'
  })).status, 201);
  const proposals = await request('/api/v2/memory-review/proposals');
  assert.equal(proposals.status, 200);
  const generation = await request('/api/v2/memory-review/opportunities/b1-need/proposals', 'POST', { idempotency_key: 'memory-not-configured' });
  assert.equal(generation.status, 503);
  assert.ok(generation.body.error.code);
  const context = await request('/api/v2/opportunities/b1-need/context');
  assert.equal(context.body.data.long_term_summary.text, '');
  assert.deepEqual(context.body.data.confirmed_facts, []);
  const foreign = await request('/api/v2/customers/b1-customer', 'GET', undefined, 'foreign-workspace');
  assert.equal(foreign.status, 404);
  assert.equal((await request('/api/v2/memory-review/proposals', 'GET', undefined, '!invalid')).status, 400);
  assert.equal((await request('/api/v2/sales-ops/unknown')).status, 404);
  assert.equal((await request('/api/v2/sales-ops/reviews')).status, 200);
  assert.deepEqual((await request('/api/v2/sales-ops/experiences?environment=simulation&product_id=fixture-product&product_version=fixture-v1')).body.data, []);
  const task = await request('/api/v2/tasks', 'POST', {
    task_id: 'b1-due-task', customer_id: 'b1-customer', opportunity_id: 'b1-need',
    owner: '演练销售', title: '核对客户问题', reason: '隔离后台提醒验收',
    due_at: new Date(Date.now() - 60_000).toISOString(), idempotency_key: 'b1-task-create'
  });
  assert.equal(task.status, 201);
  const scan = await request('/api/v2/sales-ops/notifications/scan', 'POST', { idempotency_key: 'b1-scan' });
  assert.equal(scan.status, 201);
  assert.equal(scan.body.data.created_notification_count, 1);
  assert.equal((await request('/api/v2/sales-ops/notifications/scan', 'POST', { idempotency_key: 'b1-scan' })).body.data.idempotent_replay, true);
  assert.equal((await request('/api/v2/sales-ops/notifications/scan', 'POST', { idempotency_key: 'b1-scan-again' })).body.data.created_notification_count, 0);
  const notices = await request('/api/v2/sales-ops/notifications?unread=true');
  assert.equal(notices.body.data.length, 1);
  const notice = notices.body.data[0];
  assert.equal(notice.task_id, 'b1-due-task');
  assert.deepEqual((await request('/api/v2/sales-ops/notifications', 'GET', undefined, 'foreign-workspace')).body.data, []);
  assert.equal((await request(`/api/v2/sales-ops/notifications/${notice.notification_id}`, 'PATCH', {
    expected_revision: notice.revision, idempotency_key: 'b1-read', changes: { read: true }
  })).status, 200);
  assert.equal((await request('/api/v2/sales-ops/notifications?unread=true')).body.data.length, 0);
  assert.equal((await request('/api/v2/tasks/b1-due-task', 'PATCH', {
    expected_revision: task.body.data.revision, changes: { status: 'completed', result: '人工已核对' }
  })).status, 200);
  assert.equal((await request('/api/v2/sales-ops/notifications/scan', 'POST', { idempotency_key: 'b1-scan-completed' })).body.data.scanned_task_count, 0);
});

test('without the B1 flag legacy v2 remains available and new routes do not load', async t => {
  const request = await start(t, false);
  assert.equal((await request('/api/health')).body.backend_b1_enabled, false);
  assert.equal((await request('/api/v2/customers')).status, 200);
  assert.equal((await request('/api/v2/memory-review/proposals')).status, 404);
});
