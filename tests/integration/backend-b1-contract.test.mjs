import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createBackendB1 } from '../../server/backend-b1.mjs';

function fixture(t) {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  store.createCustomer('demo', { customer_id: 'integration-customer', name: '独立后端演练客户' });
  store.addOpportunity('demo', 'integration-customer', {
    opportunity_id: 'integration-need', environment: 'simulation', product_id: 'fixture-product', product_version: 'fixture-v1'
  });
  const message = store.addMessage('demo', 'integration-need', {
    role: 'customer', text: '我的预算确定为每年30000元。', status: 'received', source: 'simulation', environment: 'simulation', idempotency_key: 'initial-message'
  }).message;
  let calls = 0;
  const runtime = createBackendB1({
    store, scanIntervalMs: 0,
    readJson: async req => req.body,
    sendJson: (res, status, payload) => { res.status = status; res.payload = payload; },
    runMemoryDify: async payload => {
      calls++;
      const context = JSON.parse(payload.inputs.context_json);
      const latest = context.messages.findLast(item => item.role === 'customer');
      return { workflow_run_id: `mock-memory-run-${calls}`, data: { status: 'succeeded', outputs: {
        result_json: JSON.stringify({
          schema_version: 'memory-proposal.v1', status: 'proposed',
          facts: [{ field: 'annual_budget_amount', value: 30000, person_id: null, opportunity_id: context.opportunity_id, evidence_message_ids: [latest.message_id], status: 'proposed' }],
          summary: { text: '客户明确年度预算为30000元，尚未确认产品方案。', through_message_id: latest.message_id, evidence_message_ids: [latest.message_id], open_objections: [], promises: [] }
        })
      } } };
    }
  });
  t.after(() => runtime.close());
  const request = async (path, method = 'GET', body, ws = 'demo') => {
    const res = {};
    const handled = await runtime.route({ method, url: path, headers: { 'x-workspace-id': ws }, body }, res, new URL(path, 'http://127.0.0.1'));
    assert.equal(handled, true);
    return res;
  };
  return { store, message, runtime, request, calls: () => calls };
}

test('backend orchestration connects validated model proposals to human confirmation, not automatic memory', async t => {
  const { store, request, calls } = fixture(t);
  const generated = await request('/api/v2/memory-review/opportunities/integration-need/proposals', 'POST', { idempotency_key: 'generate-1' });
  assert.equal(generated.status, 201, JSON.stringify(generated.payload));
  const proposal = generated.payload.data;
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.trace.workflow_run_id, 'mock-memory-run-1');
  assert.deepEqual(buildContext(store, 'demo', 'integration-need').confirmed_facts, []);
  assert.equal(buildContext(store, 'demo', 'integration-need').need_profile.budget_amount, null);
  assert.equal(buildContext(store, 'demo', 'integration-need').long_term_summary.text, '');
  const replay = await request('/api/v2/memory-review/opportunities/integration-need/proposals', 'POST', { idempotency_key: 'generate-1' });
  assert.equal(replay.payload.data.idempotent_replay, true);
  assert.equal(calls(), 1);
  const input = { expected_revision: proposal.revision, idempotency_key: 'approve-1', reviewer: '演练审核人' };
  const approved = await request(`/api/v2/memory-review/proposals/${proposal.proposal_id}/approve`, 'POST', input);
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.data.status, 'approved');
  const context = buildContext(store, 'demo', 'integration-need');
  assert.equal(context.confirmed_facts.length, 0);
  assert.equal(context.need_profile.budget_amount, 30000);
  assert.match(context.long_term_summary.text, /30000/);
  assert.equal((await request(`/api/v2/memory-review/proposals/${proposal.proposal_id}/approve`, 'POST', input)).payload.data.idempotent_replay, true);
  assert.equal(buildContext(store, 'demo', 'integration-need').need_profile.budget_amount, 30000);
});

test('new eligible messages expire pending memory before confirmation', async t => {
  const { store, request } = fixture(t);
  const generated = await request('/api/v2/memory-review/opportunities/integration-need/proposals', 'POST', { idempotency_key: 'generate-before-change' });
  assert.equal(generated.status, 201, JSON.stringify(generated.payload));
  const proposal = generated.payload.data;
  store.addMessage('demo', 'integration-need', {
    role: 'customer', text: '预算改成每年20000元。', status: 'received', source: 'simulation', environment: 'simulation', idempotency_key: 'budget-changed'
  });
  const approval = await request(`/api/v2/memory-review/proposals/${proposal.proposal_id}/approve`, 'POST', {
    expected_revision: proposal.revision, idempotency_key: 'stale-approve', reviewer: '演练审核人'
  });
  assert.equal(approval.status, 409);
  assert.equal(approval.payload.error.code, 'MEMORY_PROPOSAL_EXPIRED');
  assert.deepEqual(buildContext(store, 'demo', 'integration-need').confirmed_facts, []);
});

test('runtime overdue scanner supplies idempotency and preserves notification deduplication', t => {
  const { store, runtime } = fixture(t);
  store.createTask('demo', {
    task_id: 'runtime-due', customer_id: 'integration-customer', opportunity_id: 'integration-need',
    due_at: new Date(Date.now() - 60000).toISOString(), owner: '演练销售', reason: '核对预算', idempotency_key: 'runtime-task'
  });
  assert.equal(runtime.scanDueTasks().scanned_workspaces, 1);
  runtime.scanDueTasks();
  assert.equal(runtime.salesOps.listNotifications('demo').length, 1);
});

test('approved experience retrieval remains separate from raw edits and reopens after content changes', async t => {
  const { store, request, runtime } = fixture(t);
  const context = buildContext(store, 'demo', 'integration-need');
  const draft = store.saveDraft('demo', 'integration-need', context.latest_message_id, context.context_versions.opportunity_revision, {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '请先确认您的预算。', context_versions: context.context_versions,
    trace: { provider: 'test-fixture', workflow_run_id: 'test-fixture' }
  }, context);
  store.confirmDraft('demo', draft.draft_id, {
    expected_revision: draft.revision, final_text: '我们先确认年度预算，再核对交费安排。', delivery_mode: 'simulation',
    editor_id: 'champion-test', editor_role: 'champion', idempotency_key: 'experience-fixture-confirm'
  });
  const created = await request('/api/v2/sales-ops/reviews', 'POST', {
    draft_id: draft.draft_id, outcome: 'success', outcome_note: '演练：本次沟通问题已解决，不代表真实成交', idempotency_key: 'experience-review'
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const review = created.payload.data.review;
  const retrieval = {
    workspace_id: 'demo', environment: 'simulation', product_scope: context.product_scope,
    query: '客户担心预算不够，怎么确认年度预算和交费安排？', interaction_type: 'new_consultation'
  };
  assert.deepEqual((await runtime.retrieveExperiences(retrieval)).experiences, []);
  const approved = await request(`/api/v2/sales-ops/reviews/${review.review_id}`, 'PATCH', {
    expected_revision: review.revision, idempotency_key: 'experience-approve',
    changes: {
      approval_status: 'approved', reviewer: '演练审核人', human_reason: '先回应顾虑，再核对客户预算。',
      approved_content: '先确认年度预算和交费安排，不催促成交。', validation_status: 'passed',
      validation_note: '已在3个模拟新咨询中验证通过。', validated_by: '演练验证员'
    }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  const selected = await runtime.retrieveExperiences(retrieval);
  assert.equal(selected.experiences.length, 1);
  assert.equal(selected.experiences[0].source_review_id, review.review_id);
  assert.equal(Object.hasOwn(selected.experiences[0], 'original_text'), false);
  assert.deepEqual((await runtime.retrieveExperiences({ ...retrieval, environment: 'real' })).experiences, []);
  assert.deepEqual((await runtime.retrieveExperiences({ ...retrieval, query: '汽车轮胎尺寸' })).experiences, []);
  const edited = await request(`/api/v2/sales-ops/reviews/${review.review_id}`, 'PATCH', {
    expected_revision: approved.payload.data.review.revision, idempotency_key: 'experience-edit',
    changes: { approved_content: '先询问年度预算，再解释交费安排。' }
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.data.review.approval_status, 'pending');
  assert.deepEqual((await runtime.retrieveExperiences(retrieval)).experiences, []);
});
