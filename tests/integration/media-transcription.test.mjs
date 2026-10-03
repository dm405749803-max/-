import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../../server/database.mjs';
import { createV2Api } from '../../server/api.mjs';

async function harness(t, { configured = true } = {}) {
  const store = openDatabase(':memory:');
  store.createCustomer('demo', { customer_id: 'c1', name: '演练客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation' });
  const calls = [];
  const transcribeMedia = configured ? async input => { calls.push(input); return { status: 'review_required', transcript: '我妈妈58岁，想帮她看养老。', needs_human_review: true, review_hints: ['核对人物归属'] }; } : null;
  const readJson = async (req, maxBytes = 1_000_000) => { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > maxBytes) throw new Error('REQUEST_TOO_LARGE'); } return JSON.parse(body || '{}'); };
  const sendJson = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const route = createV2Api({ store, readJson, sendJson, transcribeMedia, mediaTranscriptionConfigured: configured });
  const server = createServer((req, res) => route(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo' }, ...options });
  return { calls, request };
}

test('transcription remains a proposal until the salesperson confirms it as a customer message', async t => {
  const { calls, request } = await harness(t);
  const body = { filename: '客户语音.m4a', mime_type: 'audio/mp4', data_base64: Buffer.from('voice').toString('base64'), duration_seconds: 8 };
  let response = await request('/api/v2/opportunities/o1/media-transcriptions', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  const proposal = (await response.json()).data;
  assert.equal(proposal.status, 'review_required');
  assert.equal(calls.length, 1);
  response = await request('/api/v2/opportunities/o1/messages');
  assert.deepEqual((await response.json()).data, []);

  response = await request('/api/v2/opportunities/o1/messages', { method: 'POST', body: JSON.stringify({ idempotency_key: 'confirmed-media-1', role: 'customer', text: proposal.transcript, status: 'received', source: 'media_transcription', occurred_at: '2026-09-24T08:00:00.000Z' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.source, 'media_transcription');
  response = await request('/api/v2/opportunities/o1/messages');
  assert.equal((await response.json()).data.length, 1);
});

test('unconfigured transcription returns a clear 503 without creating a message', async t => {
  const { request } = await harness(t, { configured: false });
  const response = await request('/api/v2/opportunities/o1/media-transcriptions', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, 'ASR_NOT_CONFIGURED');
});
