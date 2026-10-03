import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createObservabilityService } from '../../server/observability.mjs';

test('badcases are upserted by evaluation run and case and remain traceable', () => {
  const store = openDatabase(':memory:');
  const service = createObservabilityService({ store });
  const first = service.upsertBadcase('eval_any_agent', {
    case_id: 'A01', eval_run_id: 'baseline-v1', trace_id: '0123456789abcdef0123456789abcdef',
    severity: 'P1', failed_dimensions: ['memory'], root_cause_layer: 'b1_memory_contract',
    actual: { status: 'error' }, expected: { status: 'no_change' }
  });
  assert.equal(first.case_id, 'A01');
  assert.deepEqual(first.failed_dimensions, ['memory']);
  service.upsertBadcase('eval_any_agent', { case_id: 'A01', eval_run_id: 'baseline-v1', severity: 'P0', root_cause_layer: 'workflow' });
  const list = service.listBadcases('eval_any_agent', { eval_run_id: 'baseline-v1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'P0');
  assert.equal(list[0].root_cause_layer, 'workflow');
  assert.throws(() => service.reviewBadcase('eval_any_agent', list[0].badcase_id, { decision: 'approved', naturalness_score: 6 }), /integer from 1 to 5/);
  const approved = service.reviewBadcase('eval_any_agent', list[0].badcase_id, { decision: 'approved', reviewer: '产品负责人', naturalness_score: 5 });
  assert.equal(approved.human_review_status, 'approved');
  assert.equal(approved.status, 'closed');
  assert.equal(approved.regression_status, 'passed');
  assert.equal(approved.naturalness_score, 5);
  const rejectedSeed = service.upsertBadcase('eval_any_agent', { case_id: 'A02', eval_run_id: 'baseline-v1', severity: 'P0', root_cause_layer: 'human_judgment_pending', status: 'needs_review' });
  assert.throws(() => service.reviewBadcase('eval_any_agent', rejectedSeed.badcase_id, { decision: 'rejected' }), /requires a note/);
  const rejected = service.reviewBadcase('eval_any_agent', rejectedSeed.badcase_id, { decision: 'rejected', note: '没有回应客户当前问题' });
  assert.equal(rejected.status, 'open');
  assert.equal(rejected.regression_status, 'failed_human_judgment');
  store.close();
});

test('badcase classification annotates its trace and appears in release gates', () => {
  const store = openDatabase(':memory:');
  const service = createObservabilityService({ store, now: () => '2026-10-01T01:00:00.000Z' });
  const traceId = '0123456789abcdef0123456789abcdef';
  service.startTrace({ workspace_id: 'demo', trace_id: traceId, case_id: 'G01', eval_run_id: 'run-1', input: { text: '我要投诉' } });
  service.finishTrace('demo', traceId, { status: 'success', output: {} });
  service.upsertBadcase('demo', { case_id: 'G01', eval_run_id: 'run-1', trace_id: traceId, status: 'open', severity: 'P0', root_cause_layer: 'risk_gate' });
  assert.equal(service.getTrace('demo', traceId).metadata.quality_state, 'badcase');
  assert.equal(service.dashboard('demo', { eval_run_id: 'run-1' }).release_status, 'blocked');
  const item = service.listBadcases('demo', { eval_run_id: 'run-1' })[0];
  service.reviewBadcase('demo', item.badcase_id, { decision: 'approved', reviewer: '产品负责人', naturalness_score: 5 });
  const dashboard = service.dashboard('demo', { eval_run_id: 'run-1' });
  assert.equal(dashboard.cases.closed, 1);
  assert.equal(dashboard.naturalness.average, 5);
  assert.equal(service.getTrace('demo', traceId).metadata.quality_state, 'passed');
  store.close();
});
