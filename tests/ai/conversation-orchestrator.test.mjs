import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationOrchestrator, classifyConversationTurn } from '../../server/conversation-orchestrator.mjs';

function context(overrides = {}) {
  return {
    workspace_id: 'demo', opportunity_id: 'opportunity-1', latest_message_id: 'message-1',
    latest_message: '你好', contact_state: {},
    need_profile: { person_ids: ['person-1'], purpose: 'retirement', budget_amount: 20000, budget_currency: 'CNY' },
    confirmed_facts: [
      { field: 'age', value: 40, person_id: 'person-1', status: 'confirmed' },
      { field: 'funds_usage_years', value: 10, person_id: null, status: 'confirmed' }
    ],
    context_versions: { opportunity_revision: 1 },
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '您好',
    next_action: 'sales_review', missing_evidence: [], review_required: true,
    ...overrides
  };
}

test('normal reply is not blocked by background memory extraction', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result(),
    scheduleMemoryProposal: async () => { await waiting; return { status: 'pending', proposal_id: 'proposal-1' }; }
  });
  const input = context();
  assert.equal(orchestrator.scheduleBackgroundMemory({ workspaceId: input.workspace_id, opportunityId: input.opportunity_id, messageId: input.latest_message_id }).status, 'scheduled');
  const reply = await orchestrator.runMainReply(input);
  assert.equal(reply.status, 'draft_ready');
  assert.equal(reply.orchestration.route, 'intake');
  assert.equal(reply.orchestration.background_memory.status, 'running');
  release();
});

test('slow or failing B1 lookup is never called by ordinary intake or product FAQ', async () => {
  for (const latest_message of ['你好', '这款可以选几年交费？']) {
    let lookups = 0;
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => result(),
      findMemoryProposal: () => { lookups++; return new Promise(() => {}); }
    });
    const reply = await orchestrator.runMainReply(context({ latest_message }));
    assert.equal(reply.status, 'draft_ready');
    assert.equal(lookups, 0);
  }
});

test('A and B1 start independently and duplicate message scheduling has one job', async () => {
  let releaseA; let releaseB; let aCalls = 0; let bCalls = 0;
  const aWait = new Promise(resolve => { releaseA = resolve; });
  const bWait = new Promise(resolve => { releaseB = resolve; });
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => { aCalls++; await aWait; return result(); },
    scheduleMemoryProposal: async () => { bCalls++; await bWait; return { status: 'insufficient_evidence' }; }
  });
  const request = { workspaceId: 'demo', opportunityId: 'opportunity-1', messageId: 'message-1' };
  orchestrator.scheduleBackgroundMemory(request); orchestrator.scheduleBackgroundMemory(request);
  const reply = orchestrator.runMainReply(context());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(aCalls, 1); assert.equal(bCalls, 1);
  releaseA();
  assert.equal((await reply).status, 'draft_ready');
  releaseB();
});

test('all unsafe or missing B1 terminal states close the B2 gate', async () => {
  for (const status of ['not_started', 'not_configured', 'failed', 'error', 'unavailable', 'invalid_output', 'expired', 'stale_context', 'unexpected']) {
    let matches = 0;
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
      findMemoryProposal: async () => ({ status }),
      generateProductRecommendation: async () => { matches++; }
    });
    const reply = await orchestrator.runMainReply(context({ latest_message: '推荐哪款？' }));
    assert.equal(matches, 0, status);
    assert.notEqual(reply.next_action, 'run_product_match', status);
    assert.ok(['unavailable', 'stale_context'].includes(reply.status), status);
  }
});

test('only key pending memory changes block matching; no-change and human rejection preserve confirmed profile', async () => {
  for (const memory of [
    { status: 'insufficient_evidence' }, { status: 'rejected' }, { status: 'ignored' },
    { status: 'pending', facts: [] },
    { status: 'pending', facts: [{ field: 'preferred_contact_time', value: '晚上' }] },
    { status: 'pending', facts: [{ field: 'age', value: 40, person_id: 'person-1' }] }
  ]) {
    let matches = 0;
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
      findMemoryProposal: async () => memory,
      generateProductRecommendation: async () => { matches++; return { recommendation_id: 'r1', result: { status: 'ready' } }; }
    });
    const reply = await orchestrator.runMainReply(context({ latest_message: '推荐哪款？' }));
    assert.equal(matches, 1, JSON.stringify(memory));
    assert.equal(reply.orchestration.blocking_gate, 'human_decision');
    assert.equal(reply.draft, '');
  }
});

test('raw customer text and proposed facts cannot fill the confirmed profile gate', async () => {
  let matches = 0;
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
    findMemoryProposal: async () => ({ status: 'approved' }),
    generateProductRecommendation: async () => { matches++; }
  });
  const reply = await orchestrator.runMainReply(context({ latest_message: '我40岁预算2万，10年不用钱，推荐哪款？',
    confirmed_facts: [{ field: 'age', value: 40, person_id: 'person-1', status: 'proposed' }] }));
  assert.equal(matches, 0);
  assert.equal(reply.orchestration.blocking_gate, 'input_data');
  assert.ok(reply.missing_evidence.includes('insured_age'));
});

test('risk, service and FAQ routes cannot be upgraded by model output to matching', async () => {
  for (const latest_message of ['我要投诉', '不要再联系', '办理续期手续', '这款条款怎么交费？', '你好']) {
    let matches = 0;
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
      generateProductRecommendation: async () => { matches++; }
    });
    const reply = await orchestrator.runMainReply(context({ latest_message }));
    assert.equal(matches, 0);
    assert.ok(['safety_business', 'evidence'].includes(reply.orchestration.blocking_gate));
    assert.equal(reply.draft, '');
  }
});

test('a named-product difference question routes to product matching', () => {
  assert.equal(classifyConversationTurn(context({ latest_message: '启航成长和安心储备有什么区别？' })), 'product_match');
  assert.equal(classifyConversationTurn(context({ latest_message: '这款产品的收益率是多少？现在只有演练资料，没有正式计划书。' })), 'product_faq');
  assert.equal(classifyConversationTurn(context({ latest_message: '请帮我做一份养老计划书' })), 'product_match');
  assert.equal(classifyConversationTurn(context({ latest_message: '预算还是先不说，先讲讲什么时候开始领取。' })), 'intake');
});

test('a generic product catalogue question remains in discovery intake', () => {
  assert.equal(classifyConversationTurn(context({ latest_message: '你们有哪些产品？' })), 'intake');
});

test('B2 terminal outcomes have explicit actions and are never sendable drafts', async () => {
  const gates = { ready: 'human_decision', needs_information: 'input_data', needs_source: 'evidence', not_matched: 'human_decision', human_required: 'safety_business', unavailable: 'dependency', invalid_output: 'evidence' };
  for (const [status, gate] of Object.entries(gates)) {
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
      findMemoryProposal: async () => ({ status: 'approved' }),
      generateProductRecommendation: async () => ({ result: { status, missing_fields: ['test_field'] } })
    });
    const reply = await orchestrator.runMainReply(context({ latest_message: '给我推荐一款' }));
    assert.equal(reply.orchestration.product_match.status, status);
    assert.equal(reply.orchestration.blocking_gate, gate);
    assert.notEqual(reply.next_action, 'run_product_match');
    assert.equal(reply.draft, ''); assert.equal(reply.review_required, true);
  }
});

test('B1 timeout becomes failure and main/B2 exceptions are sanitized', async () => {
  const failed = createConversationOrchestrator({
    runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
    scheduleMemoryProposal: () => new Promise(() => {}), memoryWaitMs: 20, backgroundTimeoutMs: 5
  });
  const reply = await failed.runMainReply(context({ latest_message: '推荐一款' }));
  assert.equal(reply.status, 'unavailable');
  assert.equal(reply.orchestration.background_memory.status, 'failed');
  for (const failing of ['main', 'match']) {
    const orchestrator = createConversationOrchestrator({
      runSalesAssist: async () => { if (failing === 'main') throw new Error('SECRET upstream'); return result({ status: 'needs_information', next_action: 'run_product_match' }); },
      findMemoryProposal: async () => ({ status: 'approved' }),
      generateProductRecommendation: async () => { throw new Error('SECRET upstream'); }
    });
    const output = await orchestrator.runMainReply(context({ latest_message: '推荐一款' }));
    assert.equal(output.status, 'unavailable');
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
  }
});

test('matching request is pinned to versions and rejects stale recommendation replay', async () => {
  const requests = [];
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
    findMemoryProposal: async () => ({ status: 'approved' }),
    generateProductRecommendation: async request => { requests.push(request); return { stale: true, result: { status: 'ready' } }; }
  });
  const first = await orchestrator.runMainReply(context({ latest_message: '推荐一款', context_versions: { opportunity_revision: 1, profile_version: 1 } }));
  await orchestrator.runMainReply(context({ latest_message: '推荐一款', context_versions: { opportunity_revision: 1, profile_version: 2 } }));
  assert.equal(first.status, 'stale_context');
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(requests[1].contextVersions.profile_version, 2);
});

test('product match waits for current memory and blocks on pending review', async () => {
  let matched = 0;
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
    scheduleMemoryProposal: async () => ({ status: 'pending', proposal_id: 'proposal-1', revision: 1 }),
    findMemoryProposal: async () => ({ status: 'pending', proposal_id: 'proposal-1', revision: 1 }),
    generateProductRecommendation: async () => { matched += 1; }
  });
  const input = context({ latest_message: '你推荐哪一款？' });
  orchestrator.scheduleBackgroundMemory({ workspaceId: input.workspace_id, opportunityId: input.opportunity_id, messageId: input.latest_message_id });
  const reply = await orchestrator.runMainReply(input);
  assert.equal(reply.next_action, 'review_memory_before_product_match');
  assert.equal(reply.orchestration.blocking_reason, 'memory_review_required');
  assert.equal(matched, 0);
});

test('product match runs B2 after memory is safe and remains human reviewed', async () => {
  let matched = 0;
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result({ status: 'needs_information', next_action: 'run_product_match' }),
    findMemoryProposal: async () => ({ status: 'approved', proposal_id: 'proposal-1', revision: 2 }),
    generateProductRecommendation: async request => {
      matched += 1;
      assert.equal(request.latestMessageId, 'message-1');
      return { recommendation_id: 'recommendation-1', result: { status: 'ready', missing_fields: [] } };
    }
  });
  const reply = await orchestrator.runMainReply(context({ latest_message: '给我推荐一个方案' }));
  assert.equal(matched, 1);
  assert.equal(reply.next_action, 'review_product_match');
  assert.equal(reply.orchestration.product_match.recommendation_id, 'recommendation-1');
  assert.equal(reply.orchestration.product_match.review_required, true);
});

test('fact questions use RAG draft path and never invoke B2', async () => {
  let matched = 0;
  const orchestrator = createConversationOrchestrator({
    runSalesAssist: async () => result(),
    generateProductRecommendation: async () => { matched += 1; }
  });
  const reply = await orchestrator.runMainReply(context({ latest_message: '这款可以选几年交费？' }));
  assert.equal(classifyConversationTurn(context({ latest_message: '这款可以选几年交费？' })), 'product_faq');
  assert.equal(reply.orchestration.reply_path, 'rag_draft');
  assert.equal(matched, 0);
});

test('company process and general underwriting questions use public knowledge without selecting a product', () => {
  assert.equal(classifyConversationTurn(context({ latest_message: '公司统一的保单查询流程是什么？' })), 'public_faq');
  assert.equal(classifyConversationTurn(context({ latest_message: '请问保单要在哪里查询？' })), 'public_faq');
  assert.equal(classifyConversationTurn(context({ latest_message: '你能保证我一定能通过核保吗？' })), 'public_faq');
});
