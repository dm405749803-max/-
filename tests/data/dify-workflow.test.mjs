import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDifyWorkflowRunner } from '../../server/dify-workflow.mjs';

test('Dify workflow adapter forwards runSalesAssist inputs and user without nesting inputs twice', async t => {
  let received;
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: 'workflow-run-1', status: 'succeeded', outputs: { status: 'draft_ready' } } }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  const runDify = createDifyWorkflowRunner({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-only-key', timeoutMs: 2000 });
  const payload = {
    inputs: { schema_version: 'sales-assist.v1', latest_message: '保障期多久？', context_json: '{"opportunity_id":"o1"}' },
    user: 'workspace:demo:customer:c1'
  };
  const result = await runDify(payload);
  assert.equal(result.data.id, 'workflow-run-1');
  assert.equal(received.url, '/v1/workflows/run');
  assert.equal(received.authorization, 'Bearer test-only-key');
  assert.deepEqual(received.body, { inputs: payload.inputs, response_mode: 'blocking', user: payload.user });
  assert.equal(Object.hasOwn(received.body.inputs, 'inputs'), false);
});

test('Dify workflow adapter sanitizes upstream errors', async t => {
  const upstream = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'sensitive upstream body' }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  const runDify = createDifyWorkflowRunner({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret-must-not-leak', timeoutMs: 2000 });
  await assert.rejects(
    () => runDify({ inputs: { latest_message: '测试' } }),
    error => error.code === 'DIFY_UPSTREAM_ERROR'
      && !error.message.includes('secret-must-not-leak')
      && !error.message.includes('sensitive upstream body')
  );
});

test('Dify workflow adapter reports insufficient balance without leaking the provider body', async t => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { status: 'failed', error: 'status code 402: Insufficient Balance; private detail' } }));
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  const runDify = createDifyWorkflowRunner({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret', timeoutMs: 2000 });
  await assert.rejects(() => runDify({ inputs: { latest_message: '测试' } }), error =>
    error.code === 'DIFY_INSUFFICIENT_BALANCE' && error.status === 402 && !error.message.includes('private detail'));
});
