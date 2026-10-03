import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { buildContext, recentConversation } from '../../server/context.mjs';
import { selectContextMessages } from '../../server/memory-policy.mjs';

async function fixture(t, { environment = 'simulation' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-memory-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openDatabase(join(directory, 'memory.sqlite'));
  t.after(() => { try { store.close(); } catch {} });
  store.createCustomer('demo', { customer_id: 'c1', name: '跨月客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', purpose: 'retirement', environment });
  return store;
}

test('summary evidence must be eligible, in-scope, and not after its coverage boundary', async t => {
  const store = await fixture(t);
  const first = store.addMessage('demo', 'o1', { message_id: 'm-first', idempotency_key: 'first', role: 'customer', text: '旧问题', status: 'received', source: 'manual', occurred_at: '2026-08-01T00:00:00.000Z' }).message;
  const copied = store.addMessage('demo', 'o1', { message_id: 'm-copy', idempotency_key: 'copy', role: 'sales', text: '复制未发', status: 'copied', source: 'manual', occurred_at: '2026-08-01T00:01:00.000Z' }).message;
  const later = store.addMessage('demo', 'o1', { message_id: 'm-later', idempotency_key: 'later', role: 'customer', text: '后来问题', status: 'received', source: 'manual', occurred_at: '2026-09-01T00:00:00.000Z' }).message;
  assert.throws(() => store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'bad-boundary', text: '无效', through_message_id: copied.message_id, evidence_message_ids: [first.message_id], status: 'confirmed' }), error => error.code === 'SUMMARY_BOUNDARY_INVALID');
  assert.throws(() => store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'bad-evidence', text: '无效', through_message_id: first.message_id, evidence_message_ids: [copied.message_id], status: 'confirmed' }), error => error.code === 'SUMMARY_EVIDENCE_INVALID');
  assert.throws(() => store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'outside-boundary', text: '无效', through_message_id: first.message_id, evidence_message_ids: [later.message_id], status: 'confirmed' }), error => error.code === 'SUMMARY_EVIDENCE_AFTER_BOUNDARY');
});

test('cross-month correction supersedes old summary, conflicts old fact, and stales prior draft', async t => {
  const store = await fixture(t);
  const oldMessage = store.addMessage('demo', 'o1', { message_id: 'm-aug', idempotency_key: 'aug', role: 'customer', text: '每年预算3万，担心中途用钱', status: 'received', source: 'manual', occurred_at: '2026-08-01T00:00:00.000Z' }).message;
  let customer = store.getCustomer('demo', 'c1');
  store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'fact-budget-old', field: 'budget_amount', value: 30000, opportunity_id: 'o1', evidence_message_ids: [oldMessage.message_id], source: 'message', status: 'confirmed' }] });
  const oldSummary = store.addSummary('demo', 'o1', { expected_revision: 1, idempotency_key: 'summary-aug', text: '预算3万，主要顾虑流动性。', through_message_id: oldMessage.message_id, evidence_message_ids: [oldMessage.message_id], open_objections: ['liquidity'], status: 'confirmed' });
  const newMessage = store.addMessage('demo', 'o1', { message_id: 'm-sep', idempotency_key: 'sep', role: 'customer', text: '现在改成每年1万，流动性顾虑已解决', status: 'received', source: 'manual', occurred_at: '2026-09-01T00:00:00.000Z' }).message;
  const before = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', newMessage.message_id, 2, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '旧上下文草稿' }, before);

  customer = store.getCustomer('demo', 'c1');
  store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'fact-budget-new', field: 'budget_amount', value: 10000, opportunity_id: 'o1', evidence_message_ids: [newMessage.message_id], source: 'message', status: 'confirmed' }] });
  const replayedCustomer = store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'fact-budget-new', field: 'budget_amount', value: 10000, opportunity_id: 'o1', evidence_message_ids: [newMessage.message_id], source: 'message', status: 'confirmed' }] });
  assert.equal(replayedCustomer.revision, customer.revision + 1);

  const freshSummary = store.addSummary('demo', 'o1', { expected_revision: 2, idempotency_key: 'summary-sep', text: '预算已改为1万，旧顾虑已解决；金额冲突需人工复核。', through_message_id: newMessage.message_id, evidence_message_ids: [oldMessage.message_id, newMessage.message_id], open_objections: [], status: 'confirmed' });
  const replayedSummary = store.addSummary('demo', 'o1', { expected_revision: 2, idempotency_key: 'summary-sep', text: '预算已改为1万，旧顾虑已解决；金额冲突需人工复核。', through_message_id: newMessage.message_id, evidence_message_ids: [oldMessage.message_id, newMessage.message_id], open_objections: [], status: 'confirmed' });
  assert.equal(replayedSummary.idempotent_replay, true);
  assert.throws(() => store.addSummary('demo', 'o1', { expected_revision: 2, idempotency_key: 'summary-race', text: '并发旧摘要', through_message_id: newMessage.message_id, evidence_message_ids: [newMessage.message_id], status: 'confirmed' }), error => error.code === 'REVISION_CONFLICT');

  const facts = store.getCustomer('demo', 'c1').facts.filter(fact => fact.field === 'budget_amount');
  assert.equal(facts.length, 2); assert.ok(facts.every(fact => fact.status === 'conflicted'));
  const summaries = store._helpers.all('SELECT summary_id,status FROM summaries WHERE workspace_id=? AND opportunity_id=? ORDER BY created_at', 'demo', 'o1');
  assert.deepEqual(summaries.map(item => item.status), ['superseded', 'confirmed']);
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.long_term_summary.text, freshSummary.summary.text);
  assert.deepEqual(context.open_objections, []);
  assert.deepEqual(context.confirmed_facts.filter(fact => fact.field === 'budget_amount'), []);
  const stale = store.getDraft('demo', draft.draft_id);
  assert.equal(stale.stale, true); assert.equal(stale.stale_reason, 'summary_confirmed');
  assert.throws(() => store.confirmDraft('demo', draft.draft_id, { expected_revision: stale.revision, final_text: '不应确认', delivery_mode: 'simulation', idempotency_key: 'confirm-stale' }), error => error.code === 'STALE_DRAFT');
  assert.equal(oldSummary.summary.status, 'confirmed');
});

test('latest customer question stays distinct from the bidirectional conversation tail', async t => {
  const store = await fixture(t);
  store.addMessage('demo', 'o1', { message_id: 'sales-before', idempotency_key: 'sales-before', role: 'sales', text: '先前已发送', status: 'simulated_sent', source: 'simulation', occurred_at: '2026-09-01T00:00:00.000Z' });
  assert.throws(() => buildContext(store, 'demo', 'o1'), error => error.code === 'NO_CUSTOMER_MESSAGE');

  const customer = store.addMessage('demo', 'o1', { message_id: 'customer-question', idempotency_key: 'customer-question', role: 'customer', text: '保障期多久？', status: 'received', source: 'manual', occurred_at: '2026-09-01T00:01:00.000Z' }).message;
  const sales = store.addMessage('demo', 'o1', { message_id: 'sales-answer', idempotency_key: 'sales-answer', role: 'sales', text: '我先核对条款。', status: 'simulated_sent', source: 'simulation', occurred_at: '2026-09-01T00:02:00.000Z' }).message;
  store.addMessage('demo', 'o1', { message_id: 'sales-copy', idempotency_key: 'sales-copy', role: 'sales', text: '只复制未发送', status: 'copied', source: 'manual', occurred_at: '2026-09-01T00:03:00.000Z' });

  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.latest_message_id, customer.message_id);
  assert.equal(context.latest_message, '保障期多久？');
  assert.equal(context.context_versions.latest_message_id, customer.message_id);
  assert.equal(context.context_versions.latest_conversation_message_id, sales.message_id);
  assert.deepEqual(context.recent_messages.map(message => message.message_id), ['sales-before', 'customer-question', 'sales-answer']);
});

test('a newly recorded eligible sales message stales an existing draft', async t => {
  const store = await fixture(t);
  const customer = store.addMessage('demo', 'o1', { idempotency_key: 'question', role: 'customer', text: '请继续', status: 'received', source: 'manual' }).message;
  const context = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', customer.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '待发送' }, context);

  const sales = store.addMessage('demo', 'o1', { idempotency_key: 'other-sales', role: 'sales', text: '人工已经回复', status: 'simulated_sent', source: 'simulation' }).message;
  const nextContext = buildContext(store, 'demo', 'o1');
  assert.equal(nextContext.latest_message_id, customer.message_id);
  assert.equal(nextContext.context_versions.latest_conversation_message_id, sales.message_id);
  const stale = store.getDraft('demo', draft.draft_id);
  assert.equal(stale.stale, true);
  assert.equal(stale.stale_reason, 'new_conversation_message');
  assert.throws(() => store.confirmDraft('demo', draft.draft_id, { expected_revision: stale.revision, final_text: '不能再发', delivery_mode: 'simulation', idempotency_key: 'confirm-after-sales' }), error => error.code === 'STALE_DRAFT');
});

test('legacy drafts without a conversation-tail snapshot are invalid', async t => {
  const store = await fixture(t);
  const customer = store.addMessage('demo', 'o1', { idempotency_key: 'question', role: 'customer', text: '请回复', status: 'received', source: 'manual' }).message;
  const context = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', customer.message_id, 1, { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '旧草稿' }, context);
  const legacyVersions = { ...draft.context_versions };
  delete legacyVersions.latest_conversation_message_id;
  store._helpers.run('UPDATE drafts SET context_versions=? WHERE workspace_id=? AND draft_id=?', JSON.stringify(legacyVersions), 'demo', draft.draft_id);
  assert.throws(() => store.confirmDraft('demo', draft.draft_id, { expected_revision: 1, final_text: '不能发送', delivery_mode: 'simulation', idempotency_key: 'legacy-confirm' }), error => error.code === 'STALE_CONTEXT_SNAPSHOT');
});

test('memory excludes environment-mismatched legacy rows and rejects new mismatches', async t => {
  const store = await fixture(t);
  const valid = store.addMessage('demo', 'o1', { message_id: 'valid-sim', idempotency_key: 'valid-sim', role: 'customer', text: '演练问题', status: 'received', source: 'manual', occurred_at: '2026-09-01T00:00:00.000Z' }).message;
  assert.throws(() => store.addMessage('demo', 'o1', { idempotency_key: 'wrong-new', role: 'customer', text: '真实消息', status: 'received', source: 'manual', environment: 'real' }), error => error.code === 'MESSAGE_ENVIRONMENT_MISMATCH');
  store._helpers.run(`INSERT INTO messages(workspace_id,message_id,opportunity_id,idempotency_key,role,text,status,source,environment,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 'demo', 'legacy-wrong-customer', 'o1', 'legacy-wrong-customer', 'customer', '不应进入演练记忆', 'received', 'manual', 'real', '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:00.000Z');
  store._helpers.run(`INSERT INTO messages(workspace_id,message_id,opportunity_id,idempotency_key,role,text,status,source,environment,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 'demo', 'legacy-wrong-sales', 'o1', 'legacy-wrong-sales', 'sales', '也不应进入演练记忆', 'provider_confirmed_sent', 'wecom', 'real', '2026-09-01T00:02:00.000Z', '2026-09-01T00:02:00.000Z');
  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.latest_message_id, valid.message_id);
  assert.equal(context.context_versions.latest_conversation_message_id, valid.message_id);
  assert.deepEqual(context.recent_messages.map(message => message.message_id), [valid.message_id]);
});

test('memory remains isolated across opportunities and customers', async t => {
  const store = await fixture(t);
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o2', purpose: 'education', environment: 'simulation' });
  store.createCustomer('demo', { customer_id: 'c2', name: '另一客户' });
  store.addOpportunity('demo', 'c2', { opportunity_id: 'o3', purpose: 'health', environment: 'simulation' });
  const o1Message = store.addMessage('demo', 'o1', { message_id: 'o1-message', idempotency_key: 'o1-message', role: 'customer', text: '退休需求', status: 'received', source: 'manual' }).message;
  const o2Message = store.addMessage('demo', 'o2', { message_id: 'o2-message', idempotency_key: 'o2-message', role: 'customer', text: '教育需求', status: 'received', source: 'manual' }).message;
  store.addMessage('demo', 'o3', { message_id: 'o3-message', idempotency_key: 'o3-message', role: 'customer', text: '健康需求', status: 'received', source: 'manual' });

  let customer = store.getCustomer('demo', 'c1');
  store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'o2-fact', field: 'budget_amount', value: 20000, opportunity_id: 'o2', evidence_message_ids: [o2Message.message_id], source: 'message', status: 'confirmed' }] });
  customer = store.getCustomer('demo', 'c1');
  assert.throws(() => store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{ idempotency_key: 'wrong-opportunity-evidence', field: 'purpose', value: 'retirement', opportunity_id: 'o1', evidence_message_ids: [o2Message.message_id], source: 'message', status: 'confirmed' }] }), error => error.code === 'EVIDENCE_SCOPE_MISMATCH');

  const context = buildContext(store, 'demo', 'o1');
  assert.equal(context.latest_message_id, o1Message.message_id);
  assert.deepEqual(context.recent_messages.map(message => message.message_id), [o1Message.message_id]);
  assert.deepEqual(context.confirmed_facts, []);
  assert.equal(context.customer_id, 'c1');
});

test('window policy caps a same-role burst without truncating selected message text', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    message_id: `customer-${index}`, role: 'customer', status: 'received', environment: 'simulation',
    text: `完整问题-${index}`, source: 'manual', occurred_at: `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`
  }));
  const selection = selectContextMessages(messages, { environment: 'simulation', maxMessagesPerRoleGroup: 3 });
  assert.deepEqual(selection.messages.map(message => message.message_id), ['customer-9', 'customer-10', 'customer-11']);
  assert.deepEqual(selection.messages.map(message => message.text), ['完整问题-9', '完整问题-10', '完整问题-11']);
  assert.equal(selection.window.eligible_message_count, 12);
  assert.equal(selection.window.included_message_count, 3);
  assert.equal(selection.window.omitted_message_count, 9);
  assert.equal(selection.window.omitted_role_group_count, 1);
  assert.equal(selection.window.included_message_count + selection.window.omitted_message_count, selection.window.eligible_message_count);
  assert.equal(selection.window.complete, false);
});

test('memory window rejects invalid limits and overlong messages instead of silently truncating', () => {
  const messages = [{ message_id: 'long', role: 'customer', status: 'received', environment: 'simulation', text: 'x'.repeat(101), source: 'manual', occurred_at: '2026-09-01T00:00:00.000Z' }];
  assert.throws(() => recentConversation(messages, { environment: 'simulation', maxCharacters: 100, maxMessageCharacters: 100 }), error => error.code === 'CONTEXT_MESSAGE_TOO_LARGE');
  assert.throws(() => recentConversation(messages, { environment: 'simulation', maxRoleGroups: 0 }), error => error.code === 'INVALID_CONTEXT_WINDOW');
});
