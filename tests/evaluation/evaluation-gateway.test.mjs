import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../../server/evaluation-gateway.mjs';

test('evaluation parses an explicit prior sales question before the customer answer', () => {
  assert.deepEqual(__test.parseTurns('销售：您每年大概可以投入多少？\n客户：两万左右吧。'), [
    { role: 'sales', text: '您每年大概可以投入多少？' },
    { role: 'customer', text: '两万左右吧。' }
  ]);
});

test('evaluation output exposes bounded B1 evidence details', () => {
  const details = __test.evaluationMemoryDetails([{
    status: 'proposed',
    review_mode: 'sales_confirmation',
    facts: [{ field: 'acquisition_channel', value: 'video', evidence_message_ids: ['m1'] }],
    summary: { text: '客户从视频而来', evidence_message_ids: ['m1'], through_message_id: 'm1' },
    intent: { level: 'low', score: 15, reason: '刚接触', recommended_action: 'continue_discovery', signals: ['source_known'] }
  }]);
  assert.equal(details[0].facts[0].field, 'acquisition_channel');
  assert.equal(details[0].facts[0].value, 'video');
  assert.deepEqual(details[0].facts[0].evidence_message_ids, ['m1']);
  assert.equal(details[0].summary.text, '客户从视频而来');
});

test('evaluation excludes obsolete memory proposals but keeps backend audit history separate', () => {
  const current = __test.currentMemoryProposals([
    { status: 'pending', facts: [{ field: 'annual_budget_amount', value: 10000 }] },
    { status: 'observed', facts: [{ field: 'previous_annual_budget_amount', value: 20000 }] },
    { status: 'expired', facts: [{ field: 'annual_budget_amount', value: 20000 }] },
    { status: 'rejected', facts: [{ field: 'annual_budget_amount', value: 30000 }] }
  ]);
  assert.deepEqual(current.map(item => item.status), ['pending', 'observed']);
});

test('evaluation output exposes bounded B2 result details', () => {
  const details = __test.evaluationRecommendationDetails([{
    recommendation_id: 'r1',
    result: { status: 'needs_information', blocking_gate: 'missing_profile', missing_fields: ['age'], candidates: [] }
  }]);
  assert.equal(details[0].status, 'needs_information');
  assert.equal(details[0].blocking_gate, 'missing_profile');
  assert.deepEqual(details[0].missing_fields, ['age']);
});
