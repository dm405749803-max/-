import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../../server/database.mjs';
import { createV2Api } from '../../server/api.mjs';

async function harness(t, salesAssist, { aiConfigured = true } = {}) {
  const store = openDatabase(':memory:');
  store.createCustomer('demo', { customer_id: 'c1', name: '演练客户' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', environment: 'simulation' });
  const first = store.addMessage('demo', 'o1', { idempotency_key: 'first', role: 'customer', text: '第一条', status: 'received', source: 'manual' }).message;
  const readJson = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };
  const sendJson = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const route = createV2Api({ store, salesAssist, aiConfigured, readJson, sendJson });
  const server = createServer((req, res) => route(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const address = server.address();
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo' }, ...options });
  return { store, first, request };
}

test('AI availability errors distinguish a missing module from missing configuration', async t => {
  const missing = await harness(t, null, { aiConfigured: false });
  let response = await missing.request('/api/v2/opportunities/o1/drafts', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AI_MODULE_NOT_CONNECTED');

  const unconfigured = await harness(t, async () => ({ schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '' }), { aiConfigured: false });
  const productMessage = unconfigured.store.addMessage('demo', 'o1', { idempotency_key: 'product-question', role: 'customer', text: '产品怎么交费？', status: 'received', source: 'manual' }).message;
  response = await unconfigured.request('/api/v2/opportunities/o1/drafts', { method: 'POST', body: JSON.stringify({ latest_message_id: productMessage.message_id, expected_revision: 1 }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AI_NOT_CONFIGURED');
});

test('injectable AI result is persisted as review-required draft', async t => {
  const result = { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '仅供销售审核', citations: [], proposed_fact_changes: [], next_question: null, next_action: null, risk_flags: [], missing_evidence: [], review_required: true, context_versions: {}, trace: { provider: 'test', workflow_run_id: null } };
  const { first, request } = await harness(t, async context => ({ ...result, context_versions: context.context_versions }));
  const response = await request('/api/v2/opportunities/o1/drafts', { method: 'POST', body: JSON.stringify({ latest_message_id: first.message_id, expected_revision: 1 }) });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.data.draft, '仅供销售审核');
  assert.equal(payload.data.status, 'draft_ready');
  assert.equal(payload.data.review_required, true);
  assert.equal(payload.data.content, undefined);
  assert.equal(payload.data.ai_result, undefined);
  assert.equal(payload.data.context_versions.latest_message_id, first.message_id);
});

test('HTTP DTO matches the workbench customer, message, context, task and draft contract', async t => {
  const aiResult = { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '契约草稿', citations: [], risk_flags: [], review_required: true, context_versions: {}, trace: { provider: 'test-http', workflow_run_id: 'run-1' } };
  const { request } = await harness(t, async context => ({ ...aiResult, context_versions: context.context_versions }));
  let response = await request('/api/v2/customers/c1/persons', { method: 'POST', body: JSON.stringify({ person_id: 'p-child', name: '女儿', relationship: '子女', age: 8, gender: '女', source: 'manual' }) });
  assert.equal(response.status, 201);
  const person = (await response.json()).data;
  assert.equal(person.person_id, 'p-child'); assert.equal(person.age, 8); assert.equal(person.gender, '女');

  response = await request('/api/v2/customers/c1/opportunities', { method: 'POST', body: JSON.stringify({ opportunity_id: 'o-child', person_id: 'p-child', purpose: '教育安排', budget_amount: 30000, budget_currency: 'CNY', stage: '待了解', environment: 'simulation' }) });
  assert.equal(response.status, 201);
  const opportunity = (await response.json()).data;
  assert.equal(opportunity.person_id, 'p-child'); assert.deepEqual(opportunity.person_ids, ['p-child']);
  assert.equal(opportunity.budget, 30000); assert.equal(opportunity.profile_version, 2);
  assert.deepEqual(opportunity.contact_state, { marketing_opt_out: false, human_handoff: false, purchased_for_opportunity: false });

  response = await request('/api/v2/opportunities/o-child/messages', { method: 'POST', body: JSON.stringify({ message_id: 'm-child', idempotency_key: 'child-message', role: 'customer', text: '想了解一下', status: 'received', source: 'manual', occurred_at: '2026-09-23T08:00:00.000Z' }) });
  assert.equal(response.status, 201); assert.equal((await response.json()).data.text, '想了解一下');

  const detail = await (await request('/api/v2/customers/c1')).json();
  assert.equal(detail.data.contact_preferences.marketing_opt_out, false);
  assert.equal(detail.data.persons.find(item => item.person_id === 'p-child').age, 8);
  const detailOpportunity = detail.data.opportunities.find(item => item.opportunity_id === 'o-child');
  assert.equal(detailOpportunity.person_id, 'p-child'); assert.equal(detailOpportunity.profile_version, 2);
  assert.equal(typeof detailOpportunity.contact_state.purchased_for_opportunity, 'boolean');

  const messages = await (await request('/api/v2/opportunities/o-child/messages')).json();
  assert.deepEqual(Object.keys(messages.data[0]).sort(), ['created_at','environment','message_id','occurred_at','opportunity_id','role','session_id','source','status','text','trace_id'].sort());
  assert.equal(messages.data[0].occurred_at, '2026-09-23T08:00:00.000Z');
  const context = await (await request('/api/v2/opportunities/o-child/context')).json();
  assert.equal(context.data.schema_version, 'sales-assist.v1');
  assert.equal(context.data.long_term_summary.through_message_id, null);
  assert.equal(context.data.context_versions.latest_message_id, 'm-child');

  response = await request('/api/v2/tasks', { method: 'POST', body: JSON.stringify({ task_id: 't-child', title: '核对教育需求', customer_id: 'c1', opportunity_id: 'o-child', owner: '我', status: 'open', reason: '客户需要人工确认', due_at: '2026-09-24T08:00:00.000Z' }) });
  assert.equal(response.status, 201); assert.equal((await response.json()).data.title, '核对教育需求');
  const tasks = await (await request('/api/v2/tasks?status=open')).json();
  const task = tasks.data.find(item => item.task_id === 't-child');
  for (const field of ['task_id','customer_id','opportunity_id','revision','status','title','reason','owner','due_at']) assert.ok(Object.hasOwn(task, field), field);

  response = await request('/api/v2/opportunities/o-child/drafts', { method: 'POST', body: JSON.stringify({ latest_message_id: 'm-child', expected_revision: 1 }) });
  assert.equal(response.status, 201);
  const draft = (await response.json()).data;
  for (const field of ['draft_id','revision','draft','status','context_versions']) assert.ok(Object.hasOwn(draft, field), field);
  assert.equal(draft.draft, '契约草稿'); assert.equal(draft.trace.provider, 'test-http');

  response = await request('/api/v2/opportunities/o-child/drafts/latest?latest_message_id=m-child');
  assert.equal(response.status, 200);
  const latestDraft = (await response.json()).data;
  assert.equal(latestDraft.draft_id, draft.draft_id);
  assert.equal(latestDraft.draft, '契约草稿');

  response = await request('/api/v2/opportunities/o-child', { method: 'PATCH', body: JSON.stringify({ expected_revision: 1, changes: { human_handoff: true, handoff_owner: 'sales-1' } }) });
  assert.equal(response.status, 200);
  const handedOff = (await response.json()).data;
  assert.equal(handedOff.contact_state.human_handoff, true); assert.equal(handedOff.handoff_owner, 'sales-1'); assert.equal(handedOff.revision, 2);
  const afterHandoff = await (await request('/api/v2/customers/c1')).json();
  assert.equal(afterHandoff.data.opportunities.find(item => item.opportunity_id === 'o-child').contact_state.human_handoff, true);
  assert.equal(afterHandoff.data.opportunities.find(item => item.opportunity_id === 'o1').contact_state.human_handoff, false);
  const handoffContext = await (await request('/api/v2/opportunities/o-child/context')).json();
  assert.equal(handoffContext.data.contact_state.human_handoff, true);
});

test('late AI result cannot overwrite context after a newer message', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { store, first, request } = await harness(t, async () => { await waiting; return { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '旧结果' }; });
  const pending = request('/api/v2/opportunities/o1/drafts', { method: 'POST', body: JSON.stringify({ latest_message_id: first.message_id, expected_revision: 1 }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  store.addMessage('demo', 'o1', { idempotency_key: 'newer', role: 'customer', text: '抢先到达的新消息', status: 'received', source: 'manual' });
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_CONTEXT');
});

test('late AI result cannot save after a newer eligible sales message', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { store, first, request } = await harness(t, async () => { await waiting; return { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '过时结果' }; });
  const pending = request('/api/v2/opportunities/o1/drafts', { method: 'POST', body: JSON.stringify({ latest_message_id: first.message_id, expected_revision: 1 }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  store.addMessage('demo', 'o1', { idempotency_key: 'sales-during-generation', role: 'sales', text: '人工已先回复', status: 'simulated_sent', source: 'simulation' });
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_CONTEXT');
});

test('person attributes remain traceable but cannot override stable identity fields in HTTP DTOs', async t => {
  const { request } = await harness(t, async () => ({ schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '' }));
  const forged = { person_id: 'forged-id', customer_id: 'forged-customer', name: 'forged-name', relationship: 'forged-relationship', age: 8, gender: '女', note: '保留追溯' };
  let response = await request('/api/v2/customers/c1/persons', { method: 'POST', body: JSON.stringify({ person_id: 'stable-person', name: '稳定姓名', relationship: '子女', attributes: forged }) });
  assert.equal(response.status, 201);
  let person = (await response.json()).data;
  assert.equal(person.person_id, 'stable-person'); assert.equal(person.customer_id, 'c1');
  assert.equal(person.name, '稳定姓名'); assert.equal(person.relationship, '子女');
  assert.equal(person.age, 8); assert.equal(person.gender, '女');
  assert.deepEqual(person.attributes, forged);

  response = await request('/api/v2/customers/c1');
  person = (await response.json()).data.persons.find(item => item.person_id === 'stable-person');
  assert.equal(person.customer_id, 'c1'); assert.equal(person.name, '稳定姓名');
  assert.equal(person.attributes.person_id, 'forged-id'); assert.equal(person.attributes.note, '保留追溯');
});
