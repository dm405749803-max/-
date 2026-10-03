import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { ApiError } from '../../server/errors.mjs';
import { createMemoryReviewApi } from '../../server/memory-review/index.mjs';

function validProposal(context, overrides = {}) {
  return {
    schema_version: 'memory-proposal.v1',
    status: 'proposed',
    facts: [{
      field: 'daughter_age', value: 8, person_id: 'p1', opportunity_id: context.opportunity_id,
      evidence_message_ids: [context.latest_message_id], status: 'proposed'
    }],
    summary: {
      text: '客户为女儿了解教育安排，已明确孩子 8 岁。',
      through_message_id: context.context_versions.latest_conversation_message_id,
      evidence_message_ids: [context.latest_message_id],
      open_objections: [], promises: []
    },
    context_versions: { ...context.context_versions },
    trace: { provider: 'strict-mock', workflow_run_id: 'memory-run-1' },
    ...overrides
  };
}

async function fixture(t, proposeMemory = async context => validProposal(context), messageText = '女儿今年 8 岁，想了解教育安排', ws = 'demo') {
  const store = openDatabase(':memory:');
  store.createCustomer(ws, { customer_id: 'c1', name: '客户甲' });
  store.addPerson(ws, 'c1', { person_id: 'p1', name: '女儿', relationship: 'daughter' });
  store.addOpportunity(ws, 'c1', { opportunity_id: 'o1', person_ids: ['p1'], purpose: 'education', environment: 'simulation' });
  const message = store.addMessage(ws, 'o1', { message_id: 'm1', idempotency_key: 'm1', role: 'customer', text: messageText, status: 'received', source: 'manual' }).message;
  const readJson = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };
  const sendJson = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const route = createMemoryReviewApi({ store, proposeMemory, readJson, sendJson, now: () => new Date('2026-09-23T10:00:00.000Z') });
  const server = createServer((req, res) => route(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const address = server.address();
  const request = async (path, options = {}, workspace = ws) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspace, ...(options.headers || {}) },
      ...options
    });
    return { response, payload: await response.json() };
  };
  const generate = (key = 'generate-1') => request('/api/v2/memory-review/opportunities/o1/proposals', { method: 'POST', body: JSON.stringify({ idempotency_key: key }) });
  return { store, message, request, generate };
}

test('copilot intent waits for sales confirmation and never advances sales stage from an intent score', async t => {
  const ws = 'copilot-preview';
  const { store, generate, request } = await fixture(t, async context => validProposal(context, {
    intent: { level: 'high', score: 90, reason: '客户希望继续了解', recommended_action: 'human_close', evidence_message_ids: [context.latest_message_id] }
  }), '女儿今年 8 岁，想了解教育安排，现在想看看方案', ws);
  assert.equal(store._helpers.ensureOpportunity(ws, 'o1').intent_level, 'unknown');
  const stage = store._helpers.ensureOpportunity(ws, 'o1').sales_stage;
  const { response, payload } = await generate(); assert.equal(response.status, 201);
  assert.equal(store._helpers.ensureOpportunity(ws, 'o1').intent_level, 'unknown');
  assert.equal(store.listTasks(ws).length, 0);
  const approved = await request(`/api/v2/memory-review/proposals/${payload.data.proposal_id}/approve`, { method: 'POST', body: JSON.stringify({
    expected_revision: payload.data.revision, reviewer: '销售', idempotency_key: 'approve-copilot' }) });
  assert.equal(approved.response.status, 200);
  assert.equal(store._helpers.ensureOpportunity(ws, 'o1').intent_level, 'high');
  assert.equal(store._helpers.ensureOpportunity(ws, 'o1').sales_stage, stage);
});

test('unconfirmed memory enters the review queue but not ContextEnvelope', async t => {
  const { store, generate, request } = await fixture(t);
  let { response, payload } = await generate();
  assert.equal(response.status, 201);
  assert.equal(payload.data.status, 'pending');
  assert.equal(payload.data.revision, 1);
  assert.deepEqual(payload.data.source_message_ids, ['m1']);
  assert.deepEqual(payload.data.trace, { provider: 'strict-mock', workflow_run_id: 'memory-run-1' });
  assert.equal(payload.data.original_proposal.schema_version, 'memory-proposal.v1');
  assert.equal(payload.data.original_proposal.facts[0].value, 8);
  assert.equal(payload.data.idempotent_replay, false);
  const proposalId = payload.data.proposal_id;

  let context = buildContext(store, 'demo', 'o1');
  assert.deepEqual(context.confirmed_facts, []);
  assert.equal(context.long_term_summary.text, '');

  ({ response, payload } = await generate());
  assert.equal(response.status, 200);
  assert.equal(payload.data.proposal_id, proposalId);
  assert.equal(payload.data.idempotent_replay, true);
  ({ response, payload } = await request('/api/v2/memory-review/proposals?status=pending&opportunity_id=o1'));
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.map(item => item.proposal_id), [proposalId]);
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}`));
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.reviews, []);
});

test('background memory cannot recreate marketing follow-ups after opt-out', async t => {
  const { store, generate } = await fixture(t, async context => validProposal(context, {
    facts: [],
    intent: { level: 'medium', score: 50, reason: 'future_follow_up_timing', recommended_action: 'follow_up',
      evidence_message_ids: [context.latest_message_id], signals: [] }
  }), '别再联系我');
  const { response } = await generate();
  assert.equal(response.status, 201);
  assert.equal(store.getCustomer('demo', 'c1').marketing_opt_out, true);
  assert.equal(store.listTasks('demo').filter(x => x.status === 'open' && /回访|行动信号/.test(x.title)).length, 0);
  assert.equal(store.listTasks('demo').filter(x => x.title === '拒绝营销人工处理').length, 1);
});

test('background human-contact observation preserves commercial intent and reuses the synchronous handoff task', async t => {
  const f = await fixture(t, async context => validProposal(context, {
    facts: [],
    summary: {
      text: '客户明确要求人工联系。',
      through_message_id: context.latest_message_id,
      evidence_message_ids: [context.latest_message_id],
      open_objections: [], promises: []
    },
    intent: {
      level: 'unknown', score: 0, reason: 'requested_human_contact',
      recommended_action: 'human_close', preserve_current: true,
      signals: [{ type: 'requested_human_contact', weight: 0, evidence_message_ids: [context.latest_message_id] }],
      evidence_message_ids: [context.latest_message_id]
    }
  }), '麻烦安排人工联系我。');
  f.store.recordOpportunityIntent('demo', 'o1', {
    level: 'high', score: 88, reason: 'existing_commercial_intent',
    recommended_action: 'human_close', evidence_message_ids: ['m1'], source: 'test'
  });
  const before = f.store.listTasks('demo').filter(task => task.opportunity_id === 'o1');
  assert.equal(before.length, 1);
  assert.equal(before[0].reason, 'requested_human_contact');

  const generated = await f.generate();
  assert.equal(generated.response.status, 201);
  const opportunity = f.store._helpers.ensureOpportunity('demo', 'o1');
  assert.equal(opportunity.intent_level, 'high');
  assert.equal(opportunity.intent_score, 88);
  assert.equal(opportunity.intent_reason, 'existing_commercial_intent');
  assert.equal(opportunity.processing_status, 'human_handoff');
  const after = f.store.listTasks('demo').filter(task => task.opportunity_id === 'o1');
  assert.equal(after.length, 1);
  assert.equal(after[0].title, '尽快联系客户（人工接管）');
});

test('approval atomically activates facts and summary, stales drafts, and remains idempotent', async t => {
  const { store, generate, request } = await fixture(t);
  const generated = await generate();
  const proposalId = generated.payload.data.proposal_id;
  const context = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', context.latest_message_id, context.context_versions.opportunity_revision,
    { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '旧草稿' }, context);
  const input = { expected_revision: 1, idempotency_key: 'approve-1', reviewer: 'sales-1' };
  let { response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, { method: 'POST', body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.equal(payload.data.status, 'approved');
  assert.equal(payload.data.revision, 2);
  assert.equal(payload.data.approved_fact_ids.length, 1);
  assert.ok(payload.data.approved_summary_id);
  assert.equal(payload.data.idempotent_replay, false);
  assert.equal(payload.data.reviews.at(-1).action, 'approved');

  const active = buildContext(store, 'demo', 'o1');
  assert.equal(active.confirmed_facts[0].field, 'daughter_age');
  assert.equal(active.confirmed_facts[0].value, 8);
  assert.equal(active.long_term_summary.text, '客户为女儿了解教育安排，已明确孩子 8 岁。');
  assert.equal(store.getDraft('demo', draft.draft_id).stale, true);

  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, { method: 'POST', body: JSON.stringify(input) }));
  assert.equal(response.status, 200);
  assert.equal(payload.data.idempotent_replay, true);
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, {
    method: 'POST', body: JSON.stringify({ ...input, reviewer: 'different-reviewer' })
  }));
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'IDEMPOTENCY_KEY_REUSE');
  assert.equal(store.getCustomer('demo', 'c1').facts.filter(fact => fact.field === 'daughter_age').length, 1);
  assert.equal(store.getCustomer('demo', 'c1').facts.find(fact => fact.field === 'daughter_age').source, 'message');
  assert.equal(store._helpers.all('SELECT * FROM summaries WHERE workspace_id=? AND opportunity_id=?', 'demo', 'o1').length, 1);
});

test('profile-card approval creates and links the insured person and normalizes matching fields', async t => {
  const f = await fixture(t, async context => validProposal(context, {
    facts: [
      { field: 'insured_person_relationship', value: 'mother', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'insured_person_age', value: 58, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'purpose_code', value: 'retirement', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'annual_budget_amount', value: 20000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'funds_usage_years', value: 15, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }
    ]
  }), '想给妈妈准备养老，她58岁，每年预算2万元，15年内不用。');
  f.store.patchOpportunity('demo', 'o1', 1, { person_ids: [], purpose: null });
  f.store._helpers.run('DELETE FROM persons WHERE workspace_id=? AND customer_id=?', 'demo', 'c1');
  const generated = await f.generate();
  assert.equal(generated.response.status, 201);
  assert.equal(generated.payload.data.review_mode, 'solution_profile_card');
  const approved = await f.request(`/api/v2/memory-review/proposals/${generated.payload.data.proposal_id}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-profile-card', reviewer: 'sales-1' })
  });
  assert.equal(approved.response.status, 200);
  const active = buildContext(f.store, 'demo', 'o1');
  assert.equal(active.need_profile.purpose, 'retirement');
  assert.equal(active.need_profile.budget_amount, 20000);
  assert.equal(active.need_profile.budget_currency, 'CNY');
  assert.equal(active.need_profile.person_ids.length, 1);
  assert.equal(active.persons.find(person => person.person_id === active.need_profile.person_ids[0]).relationship, 'mother');
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'age').value, 58);
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'funds_usage_years').value, 15);
});

test('insured-person correction keeps self and mother as separate people with separate evidence', async t => {
  const f = await fixture(t, async context => validProposal(context, {
    facts: [
      { field: 'insured_person_relationship', value: 'mother', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m2'], status: 'proposed' },
      { field: 'insured_person_age', value: 59, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m2'], status: 'proposed' },
      { field: 'person_relationship_self', value: 'self', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'person_age_self', value: 38, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'person_relationship_mother', value: 'mother', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m2'], status: 'proposed' },
      { field: 'person_age_mother', value: 59, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m2'], status: 'proposed' }
    ],
    summary: {
      text: '客户先咨询本人，后更正为给妈妈买。', through_message_id: 'm2',
      evidence_message_ids: ['m1', 'm2'], open_objections: [], promises: []
    }
  }), '我今年38岁，先想给自己看看养老。');
  f.store.addMessage('demo', 'o1', {
    message_id: 'm2', idempotency_key: 'm2', role: 'customer',
    text: '改一下，其实这次主要是给我妈妈买，她59岁。', status: 'received', source: 'manual'
  });
  f.store.patchOpportunity('demo', 'o1', f.store._helpers.ensureOpportunity('demo', 'o1').revision, { person_ids: [] });
  f.store._helpers.run('DELETE FROM persons WHERE workspace_id=? AND customer_id=?', 'demo', 'c1');
  const generated = await f.generate();
  assert.equal(generated.response.status, 201);
  const approved = await f.request(`/api/v2/memory-review/proposals/${generated.payload.data.proposal_id}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-person-switch', reviewer: 'sales-1' })
  });
  assert.equal(approved.response.status, 200);
  const active = buildContext(f.store, 'demo', 'o1');
  const self = active.persons.find(person => person.relationship === 'self');
  const mother = active.persons.find(person => person.relationship === 'mother');
  assert.ok(self?.person_id);
  assert.ok(mother?.person_id);
  assert.notEqual(self.person_id, mother.person_id);
  assert.deepEqual(active.need_profile.person_ids, [mother.person_id]);
  const selfAge = active.confirmed_facts.find(fact => fact.field === 'age' && fact.person_id === self.person_id);
  const motherAge = active.confirmed_facts.find(fact => fact.field === 'age' && fact.person_id === mother.person_id);
  assert.equal(selfAge?.value, 38);
  assert.deepEqual(selfAge?.evidence_message_ids, ['m1']);
  assert.equal(motherAge?.value, 59);
  assert.deepEqual(motherAge?.evidence_message_ids, ['m2']);
  assert.deepEqual(active.confirmed_facts.find(fact => fact.field === 'relationship' && fact.person_id === self.person_id)?.evidence_message_ids, ['m1']);
  assert.deepEqual(active.confirmed_facts.find(fact => fact.field === 'relationship' && fact.person_id === mother.person_id)?.evidence_message_ids, ['m2']);
});

test('human-edited fact values are activated with human source and retain evidence', async t => {
  const { store, generate, request } = await fixture(t);
  const proposalId = (await generate()).payload.data.proposal_id;
  const detail = (await request(`/api/v2/memory-review/proposals/${proposalId}`)).payload.data;
  const editedFacts = detail.facts.map(fact => ({ ...fact, value: 9 }));
  let result = await request(`/api/v2/memory-review/proposals/${proposalId}`, {
    method: 'PATCH',
    body: JSON.stringify({ expected_revision: 1, idempotency_key: 'edit-human-source', reviewer: 'sales-1', reason: '人工核对为 9 岁', facts: editedFacts })
  });
  assert.equal(result.response.status, 200);
  result = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ expected_revision: 2, idempotency_key: 'approve-human-source', reviewer: 'sales-1', reason: '已人工复核' })
  });
  assert.equal(result.response.status, 200);
  const fact = store.getCustomer('demo', 'c1').facts.find(item => item.field === 'daughter_age');
  assert.equal(fact.value, 9);
  assert.equal(fact.source, 'human');
  assert.deepEqual(fact.evidence_message_ids, ['m1']);
  const approved = result.payload.data;
  assert.equal(approved.original_proposal.facts[0].value, 8);
  assert.equal(approved.reviews.find(review => review.action === 'edited').reason, '人工核对为 9 岁');
  assert.equal(approved.reviews.find(review => review.action === 'approved').reviewer, 'sales-1');
});

test('a reviewer can edit then reject without activating memory', async t => {
  const { store, generate, request } = await fixture(t);
  const proposalId = (await generate()).payload.data.proposal_id;
  const detail = (await request(`/api/v2/memory-review/proposals/${proposalId}`)).payload.data;
  const editedFacts = detail.facts.map(fact => ({ ...fact, value: 9 }));
  const editedSummary = { ...detail.summary, text: '人工修订：孩子年龄需要再次核对。' };
  const editInput = { expected_revision: 1, idempotency_key: 'edit-1', reviewer: 'sales-1', reason: '人工校正', facts: editedFacts, summary: editedSummary };
  let { response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}`, { method: 'PATCH', body: JSON.stringify(editInput) });
  assert.equal(response.status, 200);
  assert.equal(payload.data.revision, 2);
  assert.equal(payload.data.facts[0].value, 9);
  assert.equal(payload.data.reviews.at(-1).action, 'edited');
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}`, { method: 'PATCH', body: JSON.stringify(editInput) }));
  assert.equal(response.status, 200);
  assert.equal(payload.data.idempotent_replay, true);
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}`, {
    method: 'PATCH', body: JSON.stringify({ ...editInput, facts: editedFacts.map(fact => ({ ...fact, value: 10 })) })
  }));
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'IDEMPOTENCY_KEY_REUSE');

  const rejectInput = { expected_revision: 2, idempotency_key: 'reject-1', reviewer: 'sales-1', reason: '客户尚未最终确认' };
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/reject`, { method: 'POST', body: JSON.stringify(rejectInput) }));
  assert.equal(response.status, 200);
  assert.equal(payload.data.status, 'rejected');
  assert.equal(payload.data.rejection_reason, '客户尚未最终确认');
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/reject`, { method: 'POST', body: JSON.stringify(rejectInput) }));
  assert.equal(response.status, 200);
  assert.equal(payload.data.idempotent_replay, true);
  ({ response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/reject`, {
    method: 'POST', body: JSON.stringify({ ...rejectInput, reason: '不同驳回原因' })
  }));
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'IDEMPOTENCY_KEY_REUSE');
  assert.deepEqual(buildContext(store, 'demo', 'o1').confirmed_facts, []);
  assert.equal(buildContext(store, 'demo', 'o1').long_term_summary.text, '');
});

test('a message arriving during generation prevents persistence', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { store, generate } = await fixture(t, async context => { await waiting; return validProposal(context); });
  const pending = generate();
  await new Promise(resolve => setTimeout(resolve, 20));
  store.addMessage('demo', 'o1', { idempotency_key: 'm2', role: 'customer', text: '补充：预算是一万元', status: 'received', source: 'manual' });
  release();
  const { response, payload } = await pending;
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'MEMORY_PROPOSAL_STALE');
  assert.equal(store._helpers.all('SELECT * FROM memory_review_proposals').length, 0);
});

test('new messages and profile changes expire old candidates before approval', async t => {
  const first = await fixture(t);
  let proposalId = (await first.generate()).payload.data.proposal_id;
  first.store.addMessage('demo', 'o1', { idempotency_key: 'm2', role: 'customer', text: '又补充了一条', status: 'received', source: 'manual' });
  let result = await first.request(`/api/v2/memory-review/proposals/${proposalId}/approve`, { method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-stale-message', reviewer: 'sales-1' }) });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, 'MEMORY_PROPOSAL_EXPIRED');
  assert.equal((await first.request(`/api/v2/memory-review/proposals/${proposalId}`)).payload.data.status, 'expired');
  assert.deepEqual(buildContext(first.store, 'demo', 'o1').confirmed_facts, []);

  const second = await fixture(t);
  proposalId = (await second.generate()).payload.data.proposal_id;
  const customer = second.store.getCustomer('demo', 'c1');
  second.store.patchCustomer('demo', 'c1', customer.revision, { name: '客户甲（已更新）' });
  result = await second.request(`/api/v2/memory-review/proposals/${proposalId}/approve`, { method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-stale-profile', reviewer: 'sales-1' }) });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, 'MEMORY_PROPOSAL_EXPIRED');
});

test('cross-opportunity evidence and uncertain customer statements are rejected', async t => {
  const cross = await fixture(t, async context => ({
    ...validProposal(context),
    facts: [{ field: 'budget_amount', value: 10000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['foreign-message'], status: 'proposed' }]
  }));
  cross.store.addOpportunity('demo', 'c1', { opportunity_id: 'o2', environment: 'simulation' });
  cross.store.addMessage('demo', 'o2', { message_id: 'foreign-message', idempotency_key: 'foreign', role: 'customer', text: '另一个需求预算一万', status: 'received', source: 'manual' });
  let result = await cross.generate();
  assert.equal(result.response.status, 502);
  assert.equal(result.payload.error.code, 'MEMORY_EVIDENCE_INVALID');
  assert.equal(cross.store._helpers.all('SELECT * FROM memory_review_proposals').length, 0);

  const uncertain = await fixture(t, async context => validProposal(context, {
    facts: [{ field: 'budget_amount', value: 10000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }]
  }), '预算可能一万，还没定，只是在对比');
  result = await uncertain.generate();
  assert.equal(result.response.status, 502);
  assert.equal(result.payload.error.code, 'MEMORY_FACT_NOT_CONFIRMED');
});

test('approximate budget creates a review candidate instead of rejecting the whole proposal', async t => {
  const approximate = await fixture(t, async context => validProposal(context, {
    facts: [{ field: 'annual_budget', value: '2万元', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }]
  }), '58岁，每年预算大概2万元，想先看看方案');
  const result = await approximate.generate();
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.status, 'pending');
  assert.equal(result.payload.data.facts[0].field, 'annual_budget');
});

test('a constrained lower budget remains a human-reviewed change candidate', async t => {
  const constrained = await fixture(t, async context => validProposal(context, {
    facts: [{ field: 'annual_budget_amount', value: 10000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }]
  }), '现在可能只能先考虑1万。');
  const result = await constrained.generate();
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.status, 'pending');
  assert.equal(result.payload.data.facts[0].value, 10000);
});

test('an explicit liquidity constraint remains recordable even when phrased as possible', async t => {
  const constraint = await fixture(t, async context => validProposal(context, {
    facts: [{ field: 'liquidity_constraint', value: 'may_need_within_3_years', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }]
  }), '三年内可能会用到这笔钱');
  const result = await constraint.generate();
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.facts[0].field, 'liquidity_constraint');
  assert.equal(result.payload.data.review_mode, 'solution_profile_card');
  const approved = await constraint.request(`/api/v2/memory-review/proposals/${result.payload.data.proposal_id}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-liquidity', reviewer: 'sales-1' })
  });
  assert.equal(approved.response.status, 200);
  const active = buildContext(constraint.store, 'demo', 'o1');
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'liquidity_constraint').value, 'may_need_within_3_years');
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'funds_usage_years').value, 3);
});

test('one unsafe sibling fact does not discard a supported direct constraint', async t => {
  const mixed = await fixture(t, async context => validProposal(context, {
    facts: [
      { field: 'liquidity_constraint', value: 'may_need_within_3_years', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'product_interest', value: '长期储备产品', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }
    ]
  }), '三年内可能会用到这笔钱，也在询问长期储备产品');
  const result = await mixed.generate();
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.payload.data.facts.map(fact => fact.field), ['liquidity_constraint']);
});

test('uncertain liquidity does not erase explicit profile facts in the same message', async t => {
  const mixed = await fixture(t, async context => validProposal(context, {
    facts: [
      { field: 'insured_person_relationship', value: 'self', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'insured_person_age', value: 38, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'purpose_code', value: 'savings', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'annual_budget_amount', value: 20000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' },
      { field: 'liquidity_constraint', value: 'may_need_within_3_years', person_id: null, opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }
    ]
  }), '我38岁，想给自己做长期储备，每年预算2万元，但这笔钱三年内可能会用到。');
  mixed.store.patchOpportunity('demo', 'o1', 1, { person_ids: [], purpose: null });
  mixed.store._helpers.run('DELETE FROM persons WHERE workspace_id=? AND customer_id=?', 'demo', 'c1');
  const generated = await mixed.generate();
  assert.equal(generated.response.status, 201);
  assert.deepEqual(generated.payload.data.facts.map(fact => fact.field), [
    'insured_person_relationship', 'insured_person_age', 'purpose_code', 'annual_budget_amount', 'liquidity_constraint'
  ]);
  const approved = await mixed.request(`/api/v2/memory-review/proposals/${generated.payload.data.proposal_id}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-mixed-profile-liquidity', reviewer: 'sales-1' })
  });
  assert.equal(approved.response.status, 200);
  const active = buildContext(mixed.store, 'demo', 'o1');
  assert.equal(active.need_profile.purpose, 'savings');
  assert.equal(active.need_profile.budget_amount, 20000);
  assert.equal(active.persons.find(person => person.relationship === 'self')?.relationship, 'self');
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'age')?.value, 38);
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'liquidity_constraint').value, 'may_need_within_3_years');
  assert.equal(active.confirmed_facts.find(fact => fact.field === 'funds_usage_years').value, 3);
});

test('same-opportunity wrong-environment evidence and unrelated people are rejected', async t => {
  const wrongEnvironment = await fixture(t, async context => ({
    ...validProposal(context),
    facts: [{ field: 'budget_amount', value: 10000, person_id: null, opportunity_id: 'o1', evidence_message_ids: ['legacy-real'], status: 'proposed' }]
  }));
  wrongEnvironment.store._helpers.run(`INSERT INTO messages(workspace_id,message_id,opportunity_id,idempotency_key,role,text,status,source,environment,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 'demo', 'legacy-real', 'o1', 'legacy-real', 'customer', '真实环境消息', 'received', 'manual', 'real', '2026-09-23T09:00:00.000Z', '2026-09-23T09:00:00.000Z');
  let result = await wrongEnvironment.generate();
  assert.equal(result.response.status, 502);
  assert.equal(result.payload.error.code, 'MEMORY_EVIDENCE_INVALID');

  const unrelatedPerson = await fixture(t, async context => ({
    ...validProposal(context),
    facts: [{ field: 'age', value: 40, person_id: 'p2', opportunity_id: 'o1', evidence_message_ids: ['m1'], status: 'proposed' }]
  }));
  unrelatedPerson.store.createCustomer('demo', { customer_id: 'c2', name: '客户乙' });
  unrelatedPerson.store.addPerson('demo', 'c2', { person_id: 'p2', name: '乙本人', relationship: 'self' });
  result = await unrelatedPerson.generate();
  assert.equal(result.response.status, 502);
  assert.equal(result.payload.error.code, 'MEMORY_PERSON_SCOPE_MISMATCH');
});

test('insufficient model evidence returns a clear non-persistent result', async t => {
  const { store, generate } = await fixture(t, async context => ({
    schema_version: 'memory-proposal.v1',
    status: 'insufficient_evidence',
    facts: [],
    summary: null,
    context_versions: context.context_versions,
    trace: { provider: 'strict-mock', workflow_run_id: 'memory-run-insufficient' }
  }));
  const { response, payload } = await generate();
  assert.equal(response.status, 422);
  assert.equal(payload.error.code, 'MEMORY_PROPOSAL_INSUFFICIENT_EVIDENCE');
  assert.equal(store._helpers.all('SELECT * FROM memory_review_proposals').length, 0);
});

test('fact and summary activation rolls back completely when either part fails', async t => {
  const { store, generate, request } = await fixture(t);
  const proposalId = (await generate()).payload.data.proposal_id;
  const context = buildContext(store, 'demo', 'o1');
  const draft = store.saveDraft('demo', 'o1', context.latest_message_id, context.context_versions.opportunity_revision,
    { schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '不应失效' }, context);
  const customerBefore = store.getCustomer('demo', 'c1');
  const originalAddSummary = store.addSummary;
  store.addSummary = () => { throw new ApiError(422, 'TEST_SUMMARY_FAILURE', '模拟摘要写入失败'); };
  t.after(() => { store.addSummary = originalAddSummary; });
  const { response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-rollback', reviewer: 'sales-1' })
  });
  assert.equal(response.status, 422);
  assert.equal(payload.error.code, 'TEST_SUMMARY_FAILURE');
  assert.equal(store.getCustomer('demo', 'c1').revision, customerBefore.revision);
  assert.deepEqual(store.getCustomer('demo', 'c1').facts, []);
  assert.equal(store._helpers.all('SELECT * FROM summaries').length, 0);
  assert.equal(store.getDraft('demo', draft.draft_id).stale, false);
  const candidate = (await request(`/api/v2/memory-review/proposals/${proposalId}`)).payload.data;
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.revision, 1);
});

test('existing fact conflicts block approval without overwriting either value', async t => {
  const { store, generate, request, message } = await fixture(t);
  let customer = store.getCustomer('demo', 'c1');
  store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{
    idempotency_key: 'existing-age', field: 'daughter_age', value: 7, person_id: 'p1', opportunity_id: 'o1',
    evidence_message_ids: [message.message_id], source: 'message', status: 'confirmed'
  }] });
  const proposalId = (await generate()).payload.data.proposal_id;
  const { response, payload } = await request(`/api/v2/memory-review/proposals/${proposalId}/approve`, {
    method: 'POST', body: JSON.stringify({ expected_revision: 1, idempotency_key: 'approve-conflict', reviewer: 'sales-1' })
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'MEMORY_FACT_CONFLICT');
  customer = store.getCustomer('demo', 'c1');
  assert.equal(customer.facts.length, 1);
  assert.equal(customer.facts[0].value, 7);
  assert.equal(customer.facts[0].status, 'confirmed');
  assert.equal(store._helpers.all('SELECT * FROM summaries').length, 0);
});

test('missing model returns 503 while queue reads remain available and workspace-isolated', async t => {
  const { request } = await fixture(t, null);
  let { response, payload } = await request('/api/v2/memory-review/opportunities/o1/proposals', { method: 'POST', body: JSON.stringify({ idempotency_key: 'no-model' }) });
  assert.equal(response.status, 503);
  assert.equal(payload.error.code, 'MEMORY_MODEL_NOT_CONFIGURED');
  ({ response, payload } = await request('/api/v2/memory-review/proposals'));
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, []);
  ({ response, payload } = await request('/api/v2/memory-review/proposals', {}, 'other-workspace'));
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, []);
});
