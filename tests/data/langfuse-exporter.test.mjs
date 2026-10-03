import test from 'node:test';
import assert from 'node:assert/strict';
import { createLangfuseExporter, __test } from '../../server/langfuse-exporter.mjs';

test('Langfuse exporter sends the unified trace id and OTLP attributes', async () => {
  const requests = [];
  const exporter = createLangfuseExporter({
    baseUrl: 'http://127.0.0.1:3001', publicKey: 'pk-test', secretKey: 'sk-test',
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; }
  });
  const trace = {
    trace_id: '0123456789abcdef0123456789abcdef', session_id: 'session_1', customer_id: 'customer_1',
    name: 'customer-message', status: 'success', started_at: '2026-09-29T05:00:00.000Z', ended_at: '2026-09-29T05:00:01.000Z',
    input: { text: '你好' }, output: { draft: '您好' }, metadata: { route: 'A', quality_state: 'badcase', badcase_id: 'bad_1', severity: 'P0' }
  };
  await exporter.exportTrace(trace);
  await exporter.exportObservation(trace, {
    observation_id: '0123456789abcdef', trace_id: trace.trace_id, type: 'generation', name: 'dify.A_sales_draft',
    status: 'success', started_at: trace.started_at, ended_at: trace.ended_at, input: { message: '你好' }, output: { draft: '您好' },
    model: 'deepseek', input_tokens: 12, output_tokens: 8, total_tokens: 20, metadata: {}
  });
  assert.equal(requests.length, 2);
  const root = JSON.parse(requests[0].options.body).resourceSpans[0].scopeSpans[0].spans[0];
  const child = JSON.parse(requests[1].options.body).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(root.traceId, trace.trace_id);
  assert.equal(root.spanId, __test.rootSpanId(trace.trace_id));
  const tags = root.attributes.find(item => item.key === 'langfuse.trace.tags').value.arrayValue.values.map(item => item.stringValue);
  assert.deepEqual(tags, ['conversation', 'success', 'badcase', 'P0']);
  assert.equal(child.traceId, trace.trace_id);
  assert.equal(child.parentSpanId, root.spanId);
  assert.match(requests[0].options.headers.authorization, /^Basic /);
  assert.equal(requests[0].options.headers['x-langfuse-ingestion-version'], '4');
});

test('unconfigured exporter is a safe no-op', async () => {
  const exporter = createLangfuseExporter();
  assert.equal(exporter.configured, false);
  assert.deepEqual(await exporter.exportTrace({ trace_id: 'x' }), { skipped: true });
});
