import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-data-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const store = openDatabase(path, options);
  t.after(() => { try { store.close(); } catch {} });
  store.createCustomer('demo', { customer_id: 'c1', name: '客户甲' });
  store.addPerson('demo', 'c1', { person_id: 'p1', name: '女儿', relationship: 'daughter', attributes: { age: 8 } });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', person_ids: ['p1'], purpose: 'education', budget_amount: 10000, budget_currency: 'CNY', product_id: 'product-1', product_version: 'v1', environment: 'simulation' });
  return { store, path, directory };
}

test('persists normalized customer data across restart and isolates workspaces', async t => {
  const { store, path } = await fixture(t);
  store.addMessage('demo', 'o1', { idempotency_key: 'msg-1', role: 'customer', text: '想给女儿了解', status: 'received', source: 'manual' });
  store.close();
  const reopened = openDatabase(path);
  assert.equal(reopened.getCustomer('demo', 'c1').persons[0].attributes.age, 8);
  assert.equal(reopened.listMessages('demo', 'o1').length, 1);
  assert.deepEqual(reopened.listCustomers('other-workspace'), []);
  assert.throws(() => reopened.getCustomer('other-workspace', 'c1'), error => error.code === 'CUSTOMER_NOT_FOUND');
  reopened.close();
});

test('enforces optimistic revisions and message idempotency', async t => {
  const { store } = await fixture(t);
  const first = store.patchOpportunity('demo', 'o1', 1, { budget_amount: 12000 });
  assert.equal(first.revision, 2);
  assert.throws(() => store.patchOpportunity('demo', 'o1', 1, { budget_amount: 13000 }), error => error.status === 409 && error.details.current_revision === 2);
  const input = { idempotency_key: 'same-event', role: 'customer', text: '客户原话', status: 'received', source: 'manual' };
  const created = store.addMessage('demo', 'o1', input);
  assert.throws(() => store.addMessage('demo', 'o1', { ...input, text: '不应覆盖' }), error => error.code === 'IDEMPOTENCY_KEY_REUSE');
  const replay = store.addMessage('demo', 'o1', input);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.message.message_id, created.message.message_id);
  assert.equal(store.listMessages('demo', 'o1')[0].text, '客户原话');
});

test('context keeps confirmed evidence, summary boundary, and the default twelve-turn window', async t => {
  const { store } = await fixture(t);
  let last;
  for (let i = 0; i < 10; i += 1) {
    last = store.addMessage('demo', 'o1', { idempotency_key: `c-${i}`, role: 'customer', text: `客户 ${i}`, status: 'received', source: 'manual', occurred_at: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z` }).message;
    store.addMessage('demo', 'o1', { idempotency_key: `s-${i}`, role: 'sales', text: `销售 ${i}`, status: 'simulated_sent', source: 'manual', environment: 'simulation', occurred_at: `2026-09-01T00:${String(i).padStart(2, '0')}:30.000Z` });
  }
  const customer = store.getCustomer('demo', 'c1');
  store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'fact-daughter-age', field: 'daughter_age', value: 8, person_id: 'p1', opportunity_id: 'o1', evidence_message_ids: [last.message_id], source: 'message', status: 'confirmed' }] });
  store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'summary-context', text: '上次顾虑流动性', through_message_id: last.message_id, evidence_message_ids: [last.message_id], open_objections: ['liquidity'], promises: ['send verified plan'], status: 'confirmed' });
  const context = buildContext(store, 'demo', 'o1', { asOf: '2026-09-23T00:00:00.000Z' });
  assert.equal(context.recent_messages.length, 20);
  assert.equal(context.recent_messages[0].text, '客户 0');
  assert.equal(context.context_window.eligible_message_count, 20);
  assert.equal(context.context_window.included_message_count, 20);
  assert.equal(context.context_window.omitted_message_count, 0);
  assert.equal(context.context_window.complete, true);
  assert.equal(context.context_window.included_message_count + context.context_window.omitted_message_count, context.context_window.eligible_message_count);
  assert.equal(context.confirmed_facts[0].value, 8);
  assert.equal(context.long_term_summary.through_message_id, last.message_id);
  assert.deepEqual(context.open_objections, ['liquidity']);
  assert.equal(context.product_scope.as_of, '2026-09-23T00:00:00.000Z');
});

test('context exposes confirmed summaries from the same customer other opportunities', async t => {
  const { store } = await fixture(t);
  store.addOpportunity('demo', 'c1', { opportunity_id: 'education-history', purpose: '孩子教育', environment: 'simulation' });
  const history = store.addMessage('demo', 'education-history', { idempotency_key: 'history-message', role: 'customer', text: '孩子8岁，准备大学教育金', status: 'received', source: 'simulation', environment: 'simulation' }).message;
  store.addSummary('demo', 'education-history', { expected_revision: 1, idempotency_key: 'history-summary', text: '孩子8岁，准备大学教育金，10年后使用。', through_message_id: history.message_id, evidence_message_ids: [history.message_id], status: 'confirmed' });
  store.addMessage('demo', 'o1', { idempotency_key: 'current-message', role: 'customer', text: '之前孩子那个再看看', status: 'received', source: 'simulation', environment: 'simulation' });
  const context = buildContext(store, 'demo', 'o1');
  const related = context.related_opportunities.find(item => item.opportunity_id === 'education-history');
  assert.equal(related.purpose, '孩子教育');
  assert.match(related.summary, /孩子8岁/);
});

test('summary failure degrades to confirmed facts and recent messages', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'm', role: 'customer', text: '最新问题', status: 'received', source: 'manual' }).message;
  store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'summary-failed', text: '不可用摘要', through_message_id: message.message_id, status: 'failed' });
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.long_term_summary.text, '');
  assert.equal(context.recent_messages[0].text, '最新问题');
});

test('copied drafts are auditable but never enter conversation memory', async t => {
  const { store } = await fixture(t);
  const customer = store.addMessage('demo', 'o1', { idempotency_key: 'customer', role: 'customer', text: '客户问题', status: 'received', source: 'manual' }).message;
  store.addMessage('demo', 'o1', { idempotency_key: 'copy', role: 'sales', text: '只复制未发送', status: 'copied', source: 'manual' });
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.latest_message_id, customer.message_id);
  assert.deepEqual(context.recent_messages.map(item => item.text), ['客户问题']);
});

test('explicit opt-out message immediately sets durable contact state', async t => {
  const { store, path } = await fixture(t);
  store.addMessage('demo', 'o1', { idempotency_key: 'optout', role: 'customer', text: '请不要再联系我', status: 'received', source: 'manual' });
  const customer = store.getCustomer('demo', 'c1');
  assert.equal(customer.marketing_opt_out, true);
  assert.equal(buildContext(store, 'demo', 'o1').contact_state.marketing_opt_out, true);
  store.close();
  const reopened = openDatabase(path);
  assert.equal(buildContext(reopened, 'demo', 'o1').contact_state.marketing_opt_out, true);
  reopened.close();
});

test('a complaint creates an immediate assigned-or-pending human task', async t => {
  const { store } = await fixture(t);
  store.addMessage('demo', 'o1', { idempotency_key: 'complaint', role: 'customer', text: '我要投诉你们', status: 'received', source: 'manual' });
  const task = store.listTasks('demo', { status: 'open' }).find(item => item.opportunity_id === 'o1');
  assert.ok(task);
  assert.equal(task.owner, 'unassigned');
  assert.match(task.title, /投诉/);
  assert.ok(task.due_at);
  assert.equal(buildContext(store, 'demo', 'o1').contact_state.human_handoff, true);
});

test('marketing opt-out cancels marketing follow-ups but preserves service work', async t => {
  const { store } = await fixture(t);
  store.createTask('demo', { idempotency_key: 'follow-up', customer_id: 'c1', opportunity_id: 'o1', owner: 'sales', title: '按约定时间回访', reason: 'future_follow_up_timing', status: 'open' });
  store.createTask('demo', { idempotency_key: 'service', customer_id: 'c1', opportunity_id: 'o1', owner: 'service', title: '处理保全申请', reason: '客户主动合同服务', status: 'open' });
  store.addMessage('demo', 'o1', { idempotency_key: 'optout-cancel', role: 'customer', text: '别再联系我', status: 'received', source: 'manual' });
  const tasks = store.listTasks('demo');
  assert.equal(tasks.find(item => item.idempotency_key === 'follow-up').status, 'cancelled');
  assert.equal(tasks.find(item => item.idempotency_key === 'service').status, 'open');
});

test('fact evidence cannot cross customer boundaries', async t => {
  const { store } = await fixture(t);
  store.createCustomer('demo', { customer_id: 'c2', name: '客户乙' });
  store.addOpportunity('demo', 'c2', { opportunity_id: 'o2', environment: 'simulation' });
  const foreign = store.addMessage('demo', 'o2', { idempotency_key: 'foreign', role: 'customer', text: '乙的消息', status: 'received', source: 'manual' }).message;
  const customer = store.getCustomer('demo', 'c1');
  assert.throws(() => store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'fact-cross-customer', field: 'age', value: 38, opportunity_id: 'o1', evidence_message_ids: [foreign.message_id], source: 'message', status: 'confirmed' }] }), error => error.code === 'EVIDENCE_SCOPE_MISMATCH');
  assert.equal(store.getCustomer('demo', 'c1').revision, customer.revision);
});

test('condition changes invalidate plans and drafts', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'm', role: 'customer', text: '做方案', status: 'received', source: 'manual' }).message;
  const context = buildContext(store, 'demo', 'o1');
  const plan = store.savePlan('demo', 'o1', { expected_revision: 1, condition_snapshot: { budget_amount: 10000, person_id: 'p1' }, annual_data: [{ year: 1, premium: 10000, benefit: 0, cash_value: 5000 }], confirmation_status: 'confirmed', sources: [{ document_id: 'doc', version: 'v1' }] });
  const draft = store.saveDraft('demo', 'o1', message.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '待审核' }, context);
  store.patchOpportunity('demo', 'o1', 1, { budget_amount: 20000 });
  assert.equal(store.getPlans('demo', 'o1').find(item => item.plan_id === plan.plan_id).stale, true);
  assert.equal(store.getDraft('demo', draft.draft_id).stale, true);
  assert.throws(() => store.confirmDraft('demo', draft.draft_id, { expected_revision: 2, final_text: '发送', delivery_mode: 'simulation', idempotency_key: 'confirm' }), error => error.code === 'STALE_DRAFT');
});

test('confirmed plans reject unknown money and missing policy years', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.savePlan('demo', 'o1', { expected_revision: 1, condition_snapshot: {}, confirmation_status: 'confirmed', annual_data: [{ year: 1, premium: 100, benefit: 0, cash_value: 10 }, { year: 10, premium: 0, benefit: 0, cash_value: 200 }] }), error => error.code === 'MISSING_PLAN_YEAR');
  assert.throws(() => store.savePlan('demo', 'o1', { expected_revision: 1, condition_snapshot: {}, confirmation_status: 'confirmed', annual_data: [{ year: 1, premium: null, benefit: 0, cash_value: 10 }] }), error => error.code === 'UNKNOWN_CONFIRMED_PLAN_VALUE');
  assert.throws(() => store.savePlan('demo', 'o1', { expected_revision: 1, condition_snapshot: {}, annual_data: [{ year: 1, premium: '', benefit: 0, cash_value: 10 }] }), error => error.code === 'INVALID_AMOUNT');
});

test('draft confirmation records only explicit simulation/manual outcomes and is idempotent', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'm', role: 'customer', text: '请回复', status: 'received', source: 'manual' }).message;
  const context = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', message.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '原稿' }, context);
  assert.deepEqual(draft.product_scope, { ...context.product_scope, environment: 'simulation' });
  assert.throws(() => store.confirmDraft('demo', draft.draft_id, { expected_revision: 1, final_text: '终稿', delivery_mode: 'wecom', idempotency_key: 'confirm' }), error => error.code === 'DELIVERY_MODE_NOT_ALLOWED');
  const confirmed = store.confirmDraft('demo', draft.draft_id, { expected_revision: 1, final_text: '终稿', delivery_mode: 'simulation', idempotency_key: 'confirm' });
  assert.equal(confirmed.draft.status, 'simulated_sent');
  const replay = store.confirmDraft('demo', draft.draft_id, { expected_revision: 1, final_text: '不应更改', delivery_mode: 'simulation', idempotency_key: 'confirm' });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.draft.final_text, '终稿');
  assert.equal(store.listMessages('demo', 'o1').at(-1).status, 'simulated_sent');
  assert.equal(store.listMessages('demo', 'o1').length, 2);
});

test('legacy drafts keep an unknown product scope while new drafts snapshot scope and environment', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'scope-message', role: 'customer', text: '请说明产品', status: 'received', source: 'manual' }).message;
  const at = '2026-09-23T00:00:00.000Z';
  store._helpers.run(`INSERT INTO drafts(workspace_id,draft_id,opportunity_id,latest_message_id,context_versions,content,ai_result,status,revision,stale,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,0,?,?)`, 'demo', 'legacy-draft', 'o1', message.message_id, '{}', '旧草稿', '{}', 'draft_ready', at, at);
  assert.equal(store.getDraft('demo', 'legacy-draft').product_scope, null);

  const context = buildContext(store, 'demo', 'o1');
  const fresh = store.saveDraft('demo', 'o1', message.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '新草稿' }, context);
  assert.deepEqual(fresh.product_scope, { ...context.product_scope, environment: 'simulation' });
});

test('draft confirmation rejects every non-ready AI status without side effects', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'm', role: 'customer', text: '请回复', status: 'received', source: 'manual' }).message;
  const context = buildContext(store, 'demo', 'o1');
  const messageCount = store.listMessages('demo', 'o1').length;
  for (const status of ['needs_source', 'needs_information', 'human_required', 'stop_marketing', 'error']) {
    const draft = store.saveDraft('demo', 'o1', message.message_id, 1, { schema_version: 'sales-assist.v1', status, draft: `阻断结果 ${status}` }, context);
    const before = store.getDraft('demo', draft.draft_id);
    assert.throws(
      () => store.confirmDraft('demo', draft.draft_id, { expected_revision: 1, final_text: '不得发送', delivery_mode: 'simulation', idempotency_key: `confirm-${status}` }),
      error => error.status === 409 && error.code === 'DRAFT_NOT_READY' && error.details.current_status === status
    );
    assert.deepEqual(store.getDraft('demo', draft.draft_id), before);
    assert.equal(store.listMessages('demo', 'o1').length, messageCount);
  }
});

test('opt-out and human handoff stale and block drafts without auto-clearing', async t => {
  const { store } = await fixture(t);
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'm', role: 'customer', text: '不要再联系', status: 'received', source: 'manual' }).message;
  const draft = store.saveDraft('demo', 'o1', message.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '原稿' }, buildContext(store, 'demo', 'o1'));
  const customer = store.getCustomer('demo', 'c1');
  const updated = store.patchCustomer('demo', 'c1', customer.revision, { marketing_opt_out: true, human_handoff: true, handoff_owner: 'sales-1' });
  assert.equal(updated.marketing_opt_out, true);
  assert.equal(updated.human_handoff, true);
  assert.equal(store.getDraft('demo', draft.draft_id).stale_reason, 'marketing_opt_out');
});

test('tasks persist deadlines, overdue status and idempotency', async t => {
  const clock = () => new Date('2026-09-23T10:00:00.000Z');
  const { store } = await fixture(t, { now: clock });
  const input = { customer_id: 'c1', opportunity_id: 'o1', title: '核对客户条件', due_at: '2026-09-22T00:00:00.000Z', owner: 'sales-1', reason: 'follow up', idempotency_key: 'task-event' };
  const task = store.createTask('demo', input).task;
  assert.equal(task.title, '核对客户条件');
  assert.equal(store.createTask('demo', input).idempotent_replay, true);
  assert.equal(store.listTasks('demo')[0].overdue, true);
  const done = store.patchTask('demo', task.task_id, 1, { status: 'completed', result: 'called' });
  assert.equal(done.revision, 2);
  assert.equal(store.listTasks('demo')[0].overdue, false);
});

test('opportunity handoff is isolated, stales drafts, persists on restart, and honors legacy global pause', async t => {
  const { store, path } = await fixture(t);
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o2', purpose: 'retirement', environment: 'simulation' });
  const m1 = store.addMessage('demo', 'o1', { idempotency_key: 'o1-message', role: 'customer', text: '需求一', status: 'received', source: 'manual' }).message;
  store.addMessage('demo', 'o2', { idempotency_key: 'o2-message', role: 'customer', text: '需求二', status: 'received', source: 'manual' });
  const draft = store.saveDraft('demo', 'o1', m1.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '待确认' }, buildContext(store, 'demo', 'o1'));
  const handoff = store.patchOpportunity('demo', 'o1', 1, { human_handoff: true, handoff_owner: 'sales-1' });
  const purchased = store.patchOpportunity('demo', 'o2', 1, { purchased: true });
  assert.equal(handoff.human_handoff, true); assert.equal(handoff.handoff_owner, 'sales-1');
  assert.equal(purchased.purchased, true);
  assert.equal(store.getCustomer('demo', 'c1').opportunities.find(item => item.opportunity_id === 'o2').human_handoff, false);
  assert.equal(store.getDraft('demo', draft.draft_id).stale_reason, 'opportunity_conditions_changed');
  store.close();

  const reopened = openDatabase(path);
  assert.equal(buildContext(reopened, 'demo', 'o1').contact_state.human_handoff, true);
  assert.equal(buildContext(reopened, 'demo', 'o2').contact_state.human_handoff, false);
  assert.equal(buildContext(reopened, 'demo', 'o2').contact_state.purchased_for_opportunity, true);
  let customer = reopened.getCustomer('demo', 'c1');
  reopened.patchCustomer('demo', 'c1', customer.revision, { human_handoff: true, handoff_owner: 'global-owner' });
  reopened.patchOpportunity('demo', 'o1', 2, { human_handoff: false, handoff_owner: null });
  assert.equal(buildContext(reopened, 'demo', 'o1').contact_state.human_handoff, true);
  assert.equal(buildContext(reopened, 'demo', 'o2').contact_state.human_handoff, true);
  reopened.close();
});

test('budget accepts finite numeric amount, zero and null but rejects unit guessing and conflicts', async t => {
  const { store } = await fixture(t);
  assert.equal(store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-zero', budget_amount: 0, budget_currency: 'CNY' }).budget_amount, 0);
  assert.equal(store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-null', budget_amount: null, budget_currency: 'CNY' }).budget_amount, null);
  assert.equal(store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-alias', budget: 30000 }).budget_amount, 30000);
  assert.throws(() => store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-text', budget: '3万' }), error => error.code === 'INVALID_AMOUNT');
  assert.throws(() => store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-conflict', budget_amount: 30000, budget: 20000 }), error => error.code === 'BUDGET_FIELDS_CONFLICT');
  assert.throws(() => store.addOpportunity('demo', 'c1', { opportunity_id: 'budget-currency', budget_amount: 30000, budget_currency: 'USD' }), error => error.code === 'INVALID_CURRENCY');
});
