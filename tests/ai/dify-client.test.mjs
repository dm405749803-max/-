import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDifyRunner } from '../../dify/client.mjs';

const HOST = '127.0.0.1';
const PORT = 8823;

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  try {
    return await run();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('server-side Dify adapter uses the isolated 8823 test endpoint', async () => {
  let received;
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: 'run-http-1', status: 'succeeded', outputs: { status: 'draft_ready' } } }));
  }, async () => {
    const runDify = createDifyRunner({ baseUrl: `http://${HOST}:${PORT}/v1`, apiKey: 'test-only-secret', timeoutMs: 2000 });
    const result = await runDify({ inputs: { latest_message: '测试' }, user: 'workspace:demo:customer:c1' });
    assert.equal(result.data.id, 'run-http-1');
  });
  assert.equal(received.url, '/v1/workflows/run');
  assert.equal(received.authorization, 'Bearer test-only-secret');
  assert.deepEqual(received.body, {
    inputs: { latest_message: '测试' },
    response_mode: 'blocking',
    user: 'workspace:demo:customer:c1'
  });
});

test('upstream errors are sanitized and never echo the API key or response body', async () => {
  await withServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'upstream may contain sensitive details' }));
  }, async () => {
    const runDify = createDifyRunner({ baseUrl: `http://${HOST}:${PORT}/v1`, apiKey: 'secret-must-not-leak', timeoutMs: 2000 });
    await assert.rejects(
      () => runDify({ inputs: { latest_message: '测试' } }),
      error => error.code === 'DIFY_UPSTREAM_ERROR'
        && !error.message.includes('secret-must-not-leak')
        && !error.message.includes('sensitive details')
    );
  });
});

test('insufficient model balance is classified and short-circuited without repeated upstream calls', async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { status: 'failed', error: 'API request failed with status code 402: Insufficient Balance' } }));
  }, async () => {
    const runDify = createDifyRunner({ baseUrl: `http://${HOST}:${PORT}/v1`, apiKey: 'secret', timeoutMs: 2000 });
    await assert.rejects(() => runDify({ inputs: { latest_message: '测试' } }), error => error.code === 'DIFY_INSUFFICIENT_BALANCE' && error.status === 402);
    await assert.rejects(() => runDify({ inputs: { latest_message: '再次测试' } }), error => error.code === 'DIFY_INSUFFICIENT_BALANCE');
    assert.equal(calls, 1);
  });
});
