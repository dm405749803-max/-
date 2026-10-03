import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { createV2Api } from '../../server/api.mjs';
import { createBackendB1 } from '../../server/backend-b1.mjs';
import { runSalesAssist } from '../../ai/sales-assist.mjs';
import { buildContext } from '../../server/context.mjs';
import { classifyConversationTurn } from '../../ai/conversation-routing.mjs';

function fixture(t, { optOut = false, service = false, salesAssist = null, orchestrator = null, onCustomerMessage = null, aiConfigured = true } = {}) {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  store.createCustomer('demo', { customer_id: 'c1', name: '契约测试客户', marketing_opt_out: optOut });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation',
    ...(service ? { purchased: true, product_id: 'p1', product_version: 'v1', policy_contract_version: 'contract-1' } : {}) });
  const readJson = async req => req.body;
  const sendJson = (res, status, payload) => { res.status = status; res.payload = payload; };
  const api = createV2Api({ store, readJson, sendJson, salesAssist, conversationOrchestrator: orchestrator, onCustomerMessage, aiConfigured });
  const request = async (path, body, ws = 'demo') => {
    const res = {};
    await api({ method: 'POST', body, headers: { 'x-workspace-id': ws } }, res, new URL(path, 'http://localhost'));
    return res;
  };
  return { store, request, readJson, sendJson };
}
const customerMessage = (text, key = 'm1') => ({ idempotency_key: key, role: 'customer', text, status: 'received', source: 'simulation' });
const modelDraft = context => ({ schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '按绑定合同核对后办理。', review_required: true, context_versions: context.context_versions });

test('a new customer message schedules server-side reply processing exactly once', async t => {
  const scheduled = [];
  const { request } = fixture(t, { onCustomerMessage: input => { scheduled.push(input); return { status: 'scheduled' }; } });
  const first = await request('/api/v2/opportunities/o1/messages', customerMessage('你好'));
  assert.equal(first.status, 201);
  assert.equal(first.payload.data.automatic_reply.status, 'scheduled');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].opportunityId, 'o1');
  assert.equal(scheduled[0].environment, 'simulation');
  const replay = await request('/api/v2/opportunities/o1/messages', customerMessage('你好'));
  assert.equal(replay.payload.data.automatic_reply.status, 'idempotent_replay');
  assert.equal(scheduled.length, 1);
});

test('invalid data and idempotency conflicts never schedule background AI', async t => {
  let scheduled = 0;
  const { request } = fixture(t, { orchestrator: { scheduleBackgroundMemory: () => { scheduled++; return { status: 'scheduled' }; } } });
  const path = '/api/v2/opportunities/o1/messages';
  assert.equal((await request(path, { ...customerMessage('你好'), status: 'draft' })).status, 400);
  assert.equal((await request(path, customerMessage('你好'), 'another-workspace')).status, 404);
  assert.equal(scheduled, 0);
  const first = await request(path, customerMessage('你好'));
  assert.equal(first.status, 201); assert.equal(scheduled, 1);
  const replay = await request(path, customerMessage('你好'));
  assert.equal(replay.payload.data.idempotent_replay, true); assert.equal(scheduled, 1);
  const conflict = await request(path, customerMessage('不同内容'));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.error.code, 'IDEMPOTENCY_KEY_REUSE'); assert.equal(scheduled, 1);
});

test('natural human-contact and stop-message wording update processing state before AI runs', t => {
  const handoff = fixture(t);
  handoff.store.addMessage('demo', 'o1', customerMessage('客户主动要求人工联系'));
  let opportunity = handoff.store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.processing_status, 'human_handoff');
  assert.equal(opportunity.human_handoff, true);

  const stopped = fixture(t);
  stopped.store.addMessage('demo', 'o1', customerMessage('不要再给我发了'));
  opportunity = stopped.store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.processing_status, 'marketing_opt_out');
  assert.equal(stopped.store.getCustomer('demo', 'c1').marketing_opt_out, true);
});

test('profile-backed plan requests synchronously advance intent and create a priority task', t => {
  const { store } = fixture(t);
  store.addMessage('demo', 'o1', customerMessage('我今年38岁，想给自己做养老，每年预算2万元，麻烦给我一份具体计划书。'));
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.intent_level, 'high');
  assert.equal(opportunity.intent_score, 85);
  assert.equal(opportunity.sales_stage, 'solution_discussion');
  assert.equal(opportunity.processing_status, 'waiting_sales_review');
  assert.ok(store.listTasks('demo', { status: 'open' }).some(task => task.title === '优先处理客户行动信号'
    && task.reason === 'plan_requested_with_profile'));
});

test('a natural request for human contact immediately hands off without another AI question', async t => {
  const { store, request } = fixture(t, { salesAssist: runSalesAssist });
  store.recordOpportunityIntent('demo', 'o1', {
    level: 'high', score: 82, reason: 'customer_supplied_purchase_evidence', evidence_message_ids: []
  });
  store.addMessage('demo', 'o1', customerMessage('麻烦安排人工联系我。'));
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.processing_status, 'human_handoff');
  assert.equal(opportunity.human_handoff, true);
  assert.equal(opportunity.intent_level, 'high');
  assert.equal(opportunity.intent_score, 82);
  assert.equal(opportunity.intent_reason, 'customer_supplied_purchase_evidence');
  assert.ok(store.listTasks('demo', { status: 'open' }).some(task => task.title === '尽快联系客户（人工接管）'));
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(classifyConversationTurn(context), 'human_required');
  const reply = await runSalesAssist(context);
  assert.equal(reply.status, 'human_required');
  assert.equal(reply.next_question, null);
  const generated = await request('/api/v2/opportunities/o1/drafts', {
    latest_message_id: context.latest_message_id,
    expected_revision: context.context_versions.opportunity_revision
  });
  assert.equal(generated.status, 201, JSON.stringify(generated.payload));
  const tasks = store.listTasks('demo', { status: 'open' }).filter(task => task.opportunity_id === 'o1');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '尽快联系客户（人工接管）');
});

test('payment and benefit action questions increase priority without pretending profile completion', t => {
  const { store } = fixture(t);
  store.addMessage('demo', 'o1', customerMessage('这个要交几年？以后怎么领？'));
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.intent_level, 'medium');
  assert.equal(opportunity.intent_score, 65);
  assert.equal(opportunity.processing_status, 'waiting_sales_review');
  assert.equal(opportunity.purpose, null);
  assert.ok(store.listTasks('demo', { status: 'open' }).some(task => task.reason === 'product_action_questions'));
});

test('marketing opt-out remains sticky and later customer service requests go to the human owner', t => {
  const { store } = fixture(t);
  store.addMessage('demo', 'o1', customerMessage('不要再给我发了'));
  store.addMessage('demo', 'o1', customerMessage('我主动问一下续期手续怎么办？', 'm2'));
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.processing_status, 'marketing_opt_out');
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.contact_state.marketing_opt_out, true);
  assert.equal(context.contact_state.human_handoff, true);
  assert.equal(classifyConversationTurn(context), 'human_required');
});

test('explicit pause state is applied synchronously even before B1 completes', t => {
  const { store } = fixture(t);
  store.addMessage('demo', 'o1', customerMessage('家里暂时不考虑了'));
  const opportunity = store.getCustomer('demo', 'c1').opportunities[0];
  assert.equal(opportunity.intent_level, 'low');
  assert.equal(opportunity.intent_score, 10);
  assert.equal(opportunity.intent_reason, 'interest_paused');
  assert.equal(opportunity.sales_stage, 'paused');
  assert.equal(opportunity.processing_status, 'waiting_customer');
  assert.equal(store.listTasks('demo').length, 1);
});

test('a newly recorded purchased opportunity starts in purchased-service state', t => {
  const { store } = fixture(t);
  const purchased = store.addOpportunity('demo', 'c1', {
    opportunity_id: 'purchased-o2', purchased: true, purpose: '养老', environment: 'simulation'
  });
  assert.equal(purchased.sales_stage, 'won');
  assert.equal(purchased.processing_status, 'purchased_service');
});

test('opt-out permits a bound contract service draft and explicit confirmation, while marketing remains stopped', async t => {
  const { request, store } = fixture(t, { optOut: true, service: true, salesAssist: async context => modelDraft(context) });
  const message = store.addMessage('demo', 'o1', customerMessage('这张保单的续期手续是什么？')).message;
  const draft = await request('/api/v2/opportunities/o1/drafts', { latest_message_id: message.message_id, expected_revision: 1 });
  assert.equal(draft.status, 201, JSON.stringify(draft.payload));
  const row = store.getDraft('demo', draft.payload.data.draft_id);
  assert.equal(row.ai_result.interaction_type, 'contract_service');
  assert.equal(row.status, 'draft_ready');
  assert.equal(store.listMessages('demo', 'o1').length, 1);
  const confirmation = await request(`/api/v2/drafts/${row.draft_id}/confirm`, { expected_revision: 1, idempotency_key: 'review-service', final_text: row.content, delivery_mode: 'simulation' });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.payload));
  assert.equal(confirmation.payload.data.status, 'simulated_sent');
  const marketing = store.addMessage('demo', 'o1', customerMessage('再推荐一个产品', 'm2')).message;
  const stopped = await request('/api/v2/opportunities/o1/drafts', { latest_message_id: marketing.message_id, expected_revision: 1 });
  assert.equal(stopped.status, 409); assert.equal(stopped.payload.error.code, 'MARKETING_OPT_OUT');
});

test('unconfigured Dify still permits the audited ordinary intake rule, not product content', async t => {
  const { request, store } = fixture(t, { aiConfigured: false, salesAssist: runSalesAssist });
  const message = store.addMessage('demo', 'o1', customerMessage('你好')).message;
  const response = await request('/api/v2/opportunities/o1/drafts', { latest_message_id: message.message_id, expected_revision: 1 });
  assert.equal(response.status, 201);
  assert.equal(response.payload.data.trace.provider, 'lead-intake-rule');
  assert.equal(response.payload.data.review_required, false);
  const product = store.addMessage('demo', 'o1', customerMessage('产品怎么交费？', 'm2')).message;
  const blocked = await request('/api/v2/opportunities/o1/drafts', { latest_message_id: product.message_id, expected_revision: 1 });
  assert.equal(blocked.status, 503); assert.equal(blocked.payload.error.code, 'AI_NOT_CONFIGURED');
});

test('profile changes during A generation invalidate the late draft before persistence', async t => {
  let release; let started;
  const wait = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { request, store } = fixture(t, { salesAssist: async context => { started(); await wait; return modelDraft(context); } });
  const message = store.addMessage('demo', 'o1', customerMessage('你好')).message;
  const pending = request('/api/v2/opportunities/o1/drafts', { latest_message_id: message.message_id, expected_revision: 1 });
  await entered;
  store.patchCustomer('demo', 'c1', 1, { name: '已更新的客户记录' });
  release();
  const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.payload.error.code, 'STALE_CONTEXT');
  assert.equal(store.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
});

test('B1 scheduling pins message ID and rejects stale requests before calling the model', async t => {
  const { store, readJson, sendJson } = fixture(t);
  let calls = 0;
  const runtime = createBackendB1({ store, readJson, sendJson, scanIntervalMs: 0, runMemoryDify: async () => { calls++; return {}; } });
  t.after(() => runtime.close());
  const old = store.addMessage('demo', 'o1', customerMessage('旧预算')).message;
  const latest = store.addMessage('demo', 'o1', customerMessage('新预算', 'm2')).message;
  await assert.rejects(runtime.generateMemoryProposal({ workspaceId: 'demo', opportunityId: 'o1', messageId: old.message_id, idempotencyKey: `background-memory:${old.message_id}` }), error => error.code === 'MEMORY_PROPOSAL_STALE');
  await assert.rejects(runtime.generateMemoryProposal({ workspaceId: 'demo', opportunityId: 'o1', messageId: latest.message_id, idempotencyKey: `background-memory:${old.message_id}` }), error => error.code === 'IDEMPOTENCY_KEY_REUSE');
  assert.equal(calls, 0);
  assert.equal(store.raw.prepare('SELECT COUNT(*) AS n FROM memory_review_proposals').get().n, 0);
});
