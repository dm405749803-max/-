import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationGateway, __test } from '../../server/evaluation-gateway.mjs';

test('evaluation gateway parses natural-language turns without code syntax', () => {
  assert.deepEqual(__test.parseTurns('你好'), [{ role: 'customer', text: '你好' }]);
  assert.deepEqual(__test.parseTurns('客户：你好\n销售：您好\n客户：给妈妈看'), [
    { role: 'customer', text: '你好' },
    { role: 'sales', text: '您好' },
    { role: 'customer', text: '给妈妈看' }
  ]);
});

test('evaluation gateway turns one Eval request into a real backend journey', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    const response = value => ({ ok: true, status: 200, json: async () => value });
    if (path.endsWith('/messages')) return response({ data: { message_id: 'msg_1', session_id: 'session_1' }, trace_id: '0123456789abcdef0123456789abcdef' });
    if (path.endsWith('/context')) return response({ data: { latest_message_id: 'msg_1', context_versions: { opportunity_revision: 1 } } });
    if (path.endsWith('/drafts')) return response({ data: { draft: '你好，请问想给谁了解？', status: 'draft_ready', citations: [], risk_flags: [], review_required: false, orchestration: { route: 'intake' } }, trace_id: '0123456789abcdef0123456789abcdef' });
    if (path.includes('/observability/traces/')) return response({ data: { session_id: 'session_1', metadata: { route: 'intake' }, observations: [] } });
    if (path.includes('/memory-review/proposals') || path.includes('/recommendations')) return response({ data: [] });
    return response({ data: {} });
  };
  const gateway = createEvaluationGateway({ baseUrl: 'http://127.0.0.1:8833', fetchImpl, sleep: async () => {}, b1WaitMs: 0 });
  const result = await gateway({ case_id: 'A01', customer_input: '你好', eval_run_id: 'baseline-1' });
  assert.equal(result.actual_response, '你好，请问想给谁了解？');
  assert.equal(result.trace_id, '0123456789abcdef0123456789abcdef');
  assert.equal(result.session_id, 'session_1');
  assert.equal(result.route, 'intake');
  assert.equal(result.checks.question_count, 1);
  assert.ok(calls.some(call => call.url.endsWith('/api/v2/customers')));
  assert.ok(calls.some(call => call.url.endsWith('/drafts')));
  const messageCall = calls.find(call => call.url.endsWith('/messages'));
  assert.equal(messageCall.options.headers['x-eval-case-id'], 'A01');
  assert.equal(messageCall.options.headers['x-eval-run-id'], 'baseline-1');
});

test('H17 evaluation fixture performs the required human profile approval before scoring', async () => {
  const calls = [];
  let approved = false;
  const proposal = {
    proposal_id: 'proposal-h17', revision: 1,
    status: 'pending', review_mode: 'solution_profile_card',
    facts: [
      { field: 'insured_person_relationship', value: 'mother' },
      { field: 'insured_person_age', value: 59 },
      { field: 'purpose_code', value: 'retirement' }
    ]
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    const path = parsed.pathname;
    const response = value => ({ ok: true, status: 200, json: async () => value });
    if (path.endsWith('/messages')) return response({ data: { message_id: `msg-${calls.length}`, session_id: 'session-h17' }, trace_id: 'abcdefabcdefabcdefabcdefabcdefab' });
    if (path.endsWith('/context')) return response({ data: { latest_message_id: `msg-${calls.length - 1}`, context_versions: { opportunity_revision: 1 } } });
    if (path.endsWith('/drafts')) return response({ data: { draft: '已记录切换为妈妈，确认前不进入产品匹配。', status: 'draft_ready', citations: [], risk_flags: [], review_required: true, orchestration: { route: 'intake' } }, trace_id: 'abcdefabcdefabcdefabcdefabcdefab' });
    if (path.includes('/observability/traces/')) return response({ data: { metadata: { route: 'intake' }, observations: [{ name: 'dify.B1_memory', status: 'success' }] } });
    if (path.endsWith('/memory-review/proposals')) return response({ data: [{ ...proposal, status: approved ? 'approved' : 'pending' }] });
    if (path.endsWith('/memory-review/proposals/proposal-h17/approve')) { approved = true; return response({ data: { ...proposal, status: 'approved' } }); }
    if (path.includes('/recommendations')) return response({ data: [] });
    if (path.endsWith('/tasks')) return response({ data: [] });
    if (/\/api\/v2\/customers\/[^/]+$/.test(path)) return response({ data: {
      persons: approved ? [{ person_id: 'person-mother', relationship: 'mother', age: 59 }] : [],
      opportunities: [{ opportunity_id: path.includes('never') ? 'never' : 'eval-opp-h17-fixed', person_ids: approved ? ['person-mother'] : [], purpose: approved ? 'retirement' : null }]
    } });
    return response({ data: {} });
  };
  const gateway = createEvaluationGateway({ baseUrl: 'http://127.0.0.1:8833', fetchImpl, sleep: async () => {}, b1WaitMs: 0 });
  const originalRandom = globalThis.crypto;
  const result = await gateway({
    case_id: 'H17', eval_run_id: 'targeted-h17',
    customer_input: '客户：我今年38岁，先想给自己看看养老。\n销售：好的，我先按您本人记录。\n客户：改一下，其实这次主要是给我妈妈买，她59岁。'
  });
  assert.equal(approved, true);
  assert.deepEqual(result.evaluation_human_actions.map(item => item.action), ['approve_insured_person_switch']);
  assert.ok(calls.some(call => call.url.endsWith('/memory-review/proposals/proposal-h17/approve')));
  assert.equal(originalRandom, globalThis.crypto);
});
