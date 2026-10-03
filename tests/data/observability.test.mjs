import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createObservabilityService, createTraceId } from '../../server/observability.mjs';

test('observability keeps one session across messages and one trace across pipeline observations', async t => {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  store.createCustomer('demo', { customer_id: 'c1', name: '测试客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation' });
  const tracing = createObservabilityService({ store });
  const sessionA = tracing.getSession('demo', 'o1', 'c1', 'simulation');
  const sessionB = tracing.getSession('demo', 'o1', 'c1', 'simulation');
  assert.equal(sessionA.session_id, sessionB.session_id);

  const traceId = createTraceId();
  assert.match(traceId, /^[0-9a-f]{32}$/);
  tracing.startTrace({ workspace_id: 'demo', trace_id: traceId, session_id: sessionA.session_id,
    customer_id: 'c1', opportunity_id: 'o1', message_id: 'm1', case_id: 'B01', eval_run_id: 'baseline-1',
    input: { text: '我妈妈今年58岁' } });
  await tracing.observe({ workspace_id: 'demo', trace_id: traceId, name: 'route.decide', type: 'span', input: {} }, async () => ({ route: 'intake' }));
  await tracing.observe({ workspace_id: 'demo', trace_id: traceId, name: 'dify.B1_memory', type: 'generation', input: {} }, async () => ({ status: 'pending' }));
  tracing.finishTrace('demo', traceId, { status: 'success', output: { draft_ready: true } });
  const trace = tracing.getTrace('demo', traceId);
  assert.equal(trace.session_id, sessionA.session_id);
  assert.equal(trace.case_id, 'B01');
  assert.equal(trace.eval_run_id, 'baseline-1');
  assert.deepEqual(trace.observations.map(item => item.name), ['route.decide', 'dify.B1_memory']);
  assert.equal(trace.status, 'success');
});

test('analytics events deduplicate, hash customers and feed the quality dashboard', t => {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const tracing = createObservabilityService({ store, now: () => '2026-10-01T01:00:00.000Z' });
  const first = tracing.recordEvent('demo', {
    event_name: 'message_received', customer_id: 'customer-secret', opportunity_id: 'o1',
    idempotency_key: 'message:m1:received', payload: { source: 'wechat' }
  });
  tracing.recordEvent('demo', {
    event_name: 'message_received', customer_id: 'customer-secret', opportunity_id: 'o1',
    idempotency_key: 'message:m1:received', payload: { source: 'wechat-replay' }
  });
  tracing.recordEvent('demo', { event_name: 'draft_generated', customer_id: 'customer-secret', idempotency_key: 'draft:d1:generated' });
  tracing.recordEvent('demo', { event_name: 'draft_confirmed_sent', customer_id: 'customer-secret', idempotency_key: 'draft:d1:sent' });
  assert.notEqual(first.customer_id_hash, 'customer-secret');
  assert.equal(tracing.listEvents('demo', { event_name: 'message_received' }).length, 1);
  const dashboard = tracing.dashboard('demo');
  assert.equal(dashboard.funnel.customer_messages, 1);
  assert.equal(dashboard.funnel.customer_uv, 1);
  assert.equal(dashboard.funnel.draft_adoption_rate, 100);
  assert.equal(dashboard.release_status, 'data_pending');
});
