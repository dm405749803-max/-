import test from 'node:test';
import assert from 'node:assert/strict';
import { runSalesAssist, __test } from '../../ai/sales-assist.mjs';
import { retrieveKnowledge, loadSimulationKnowledge, __test as knowledgeTest } from '../../knowledge/retrieve.mjs';

const FIXED_NOW = () => new Date('2026-09-23T04:00:00.000Z');

function context(overrides = {}) {
  const base = {
    schema_version: 'sales-assist.v1',
    workspace_id: 'demo',
    customer_id: 'customer-1',
    opportunity_id: 'opportunity-1',
    latest_message_id: 'message-1',
    latest_message: '这款可以选几年交费？',
    contact_state: { marketing_opt_out: false, human_handoff: false, purchased_for_opportunity: false },
    persons: [],
    confirmed_facts: [],
    recent_messages: [],
    long_term_summary: { text: '', through_message_id: null, evidence_message_ids: [] },
    open_objections: [],
    promises: [],
    product_scope: { product_id: 'product-1', product_version: 'v1', policy_contract_version: null, as_of: '2026-09-23' },
    verified_plan: null,
    context_versions: {
      customer_revision: 1,
      opportunity_revision: 1,
      profile_version: 1,
      latest_message_id: 'message-1',
      latest_conversation_message_id: 'message-1'
    }
  };
  return {
    ...base,
    ...overrides,
    contact_state: { ...base.contact_state, ...(overrides.contact_state || {}) },
    product_scope: { ...base.product_scope, ...(overrides.product_scope || {}) },
    context_versions: { ...base.context_versions, ...(overrides.context_versions || {}) }
  };
}

function document(overrides = {}) {
  return {
    document_id: 'terms-v1',
    version: 'v1',
    title: '测试产品条款',
    knowledge_type: 'product',
    product_id: 'product-1',
    product_version: 'v1',
    policy_contract_versions: [],
    scopes: ['new_consultation'],
    lifecycle_status: 'active',
    index_status: 'ready',
    verification_status: 'business_verified',
    customer_use: 'approved',
    valid_from: '2026-01-01',
    valid_to: null,
    source: { publisher: '测试发布者', label: '测试条款', url: 'https://example.invalid/terms-v1', retrieved_at: '2026-09-23' },
    topics: ['payment_term'],
    chunks: [{ location: '交费期', keywords: ['交费', '几年交', '3年交'], text: '测试产品可选3年交；该内容仅用于自动化测试。' }],
    ...overrides
  };
}

function dependencies(documents = [document()], output = {}) {
  return {
    now: FIXED_NOW,
    retrieveKnowledge: request => retrieveKnowledge(request, { documents, now: FIXED_NOW }),
    runDify: async () => ({
      workflow_run_id: 'workflow-run-1',
      outputs: {
        status: 'draft_ready',
        draft: '这个版本的测试资料列出了3年交，其他选项还要继续核对。',
        citation_ids: ['terms-v1#交费期'],
        next_question: null,
        next_action: 'sales_review',
        risk_flags: [],
        missing_evidence: [],
        provider: 'mock-dify',
        ...output
      }
    })
  };
}

function simulationContext(overrides = {}) {
  return context({
    environment: 'simulation',
    latest_message: '3年交、5年交、10年交，这个演练产品能选哪个？',
    product_scope: {
      product_id: 'fixture-product',
      product_version: 'fixture-v1',
      policy_contract_version: null,
      as_of: '2026-09-23'
    },
    ...overrides
  });
}

function simulationDify(output = {}) {
  return async () => ({
    workflow_run_id: 'simulation-workflow-run-1',
    outputs: {
      draft_result_json: JSON.stringify({
        status: 'draft_ready',
        draft: '按 fixture-v1 演练资料，这个虚构产品只支持 3 年交。',
        citation_ids: ['fixture-terms-v1#交费期测试段落'],
        next_question: null,
        next_action: 'sales_review',
        risk_flags: [],
        missing_evidence: [],
        provider: 'mock-dify',
        ...output
      })
    }
  });
}

test('intent-state customer messages receive the correct operational response', async () => {
  const cases = [
    ['家里暂时不考虑了', 'draft_ready', /暂停跟进/],
    ['明年年底再考虑', 'draft_ready', /明年再考虑/],
    ['如果今天决定，怎么办手续？', 'draft_ready', /销售马上接手/]
  ];
  for (const [latest_message, status, reply] of cases) {
    const result = await runSalesAssist(context({ latest_message, product_scope: { product_id: '', product_version: '' } }), dependencies([]));
    assert.equal(result.status, status, latest_message);
    assert.match(result.draft, reply, latest_message);
  }
});

test('a mother retirement inquiry asks for the mother age rather than the customer age', async () => {
  const result = await runSalesAssist(context({
    latest_message: '客户明确说给妈妈做养老，但不愿说预算',
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /您妈妈现在大概多大/);
  assert.doesNotMatch(result.draft, /自己的养老/);
});

test('repeated payment and receiving questions are handed to sales without a fabricated answer', async () => {
  const result = await runSalesAssist(context({
    latest_message: '客户频繁问具体交费和领取，但始终不提供购买对象',
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'human_required');
  assert.match(result.draft, /优先请销售接手/);
});

test('payment-duration and receiving questions get a natural source-bound follow-up instead of restarting intake', async () => {
  const result = await runSalesAssist(context({
    latest_message: '这个要交几年？以后怎么领？',
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /交费年限/);
  assert.match(result.draft, /领取方式/);
  assert.match(result.draft, /正式计划书|正式资料/);
  assert.doesNotMatch(result.draft, /想给谁买/);
  assert.equal(result.next_question, null);
  assert.equal(result.next_action, 'priority_sales_follow_up');
  assert.equal(result.review_required, true);
});

test('liquidity conflicts and return-ranking requests receive useful safe replies', async () => {
  const liquidity = await runSalesAssist(context({ latest_message: '客户强调三年内可能用钱，却询问长期储备产品' }));
  assert.equal(liquidity.status, 'draft_ready');
  assert.match(liquidity.draft, /三年内可能要用/);
  assert.match(liquidity.draft, /可能不适合/);
  assert.equal(liquidity.review_required, true);

  const ranking = await runSalesAssist(context({ latest_message: '你直接告诉我最赚钱的一款' }));
  assert.equal(ranking.status, 'draft_ready');
  assert.match(ranking.draft, /不能按“最赚钱”/);
  assert.doesNotMatch(ranking.draft, /保证收益|这款最赚/);
  assert.match(ranking.draft, /流动性/);
});

test('T01: multiple ages are attributed to separate known people', async () => {
  const input = context({
    latest_message: '我38岁，想给8岁的女儿买，这款怎么交费？',
    persons: [
      { person_id: 'person-self', relationship_to_customer: 'self', name: '王女士' },
      { person_id: 'person-daughter', relationship_to_customer: 'daughter', name: '女儿' }
    ]
  });
  const result = await runSalesAssist(input, dependencies());
  assert.equal(result.status, 'draft_ready');
  assert.deepEqual(result.proposed_fact_changes.map(item => [item.person_id, item.field, item.value]), [
    ['person-self', 'age', 38],
    ['person-daughter', 'age', 8]
  ]);
  assert.ok(result.proposed_fact_changes.every(item => item.status === 'proposed'));
});

test('T01: an unresolved family member is not silently written to another person', async () => {
  const result = await runSalesAssist(context({
    latest_message: '我38岁，想给8岁的女儿买，这款怎么交费？',
    persons: [{ person_id: 'person-self', relationship_to_customer: 'self' }]
  }), dependencies());
  assert.deepEqual(result.proposed_fact_changes.map(item => [item.person_id, item.value]), [['person-self', 38]]);
  assert.ok(result.missing_evidence.includes('person_identity_unresolved:daughter'));
  assert.match(result.next_question, /女儿/);
});

test('T02: negated and comparison payment terms do not become proposed facts', async () => {
  for (const latest_message of ['不想3年交，先别按这个做方案。', '只是比较5年交，还没选。']) {
    const result = await runSalesAssist(context({ latest_message }), dependencies());
    assert.equal(result.proposed_fact_changes.some(item => item.field === 'payment_term'), false, latest_message);
    assert.ok(result.risk_flags.includes('negated_or_comparison_payment_term_not_persisted'));
  }
});

test('an affirmative payment term remains a proposed, not confirmed, opportunity fact', async () => {
  const result = await runSalesAssist(context({ latest_message: '我想按3年交先看方案。' }), dependencies());
  const fact = result.proposed_fact_changes.find(item => item.field === 'payment_term');
  assert.deepEqual({ value: fact.value, opportunity_id: fact.opportunity_id, status: fact.status }, {
    value: '3 年交', opportunity_id: 'opportunity-1', status: 'proposed'
  });
});

test('D06/T17: unrelated confirmed experience is omitted', async () => {
  const irrelevant = document({
    document_id: 'surrender-experience',
    knowledge_type: 'experience',
    product_id: null,
    product_version: null,
    topics: ['surrender'],
    chunks: [{ location: '处理流程', keywords: ['退保', '投诉'], text: '退保咨询转人工。' }]
  });
  const result = await retrieveKnowledge({
    query: '想为孩子准备大学教育费',
    interaction_type: 'new_consultation',
    product_scope: { product_id: 'product-1', product_version: 'v1' },
    as_of: '2026-09-23'
  }, { documents: [irrelevant], now: FIXED_NOW });
  assert.deepEqual(result.documents, []);
  assert.ok(result.rejected.some(item => item.reason === 'low_relevance'));
});

test('public-source checked material stays behind the business-review gate', async () => {
  let difyCalls = 0;
  const result = await runSalesAssist(context({
    product_scope: { product_id: 'cpic-mhr-2025', product_version: 'public-2025-09-04' }
  }), {
    now: FIXED_NOW,
    runDify: async () => { difyCalls += 1; return {}; }
  });
  assert.equal(result.status, 'needs_source');
  assert.equal(difyCalls, 0);
  assert.ok(result.risk_flags.includes('business_review_pending'));
  assert.ok(result.missing_evidence.includes('candidate_source_not_business_approved'));
});

test('simulation knowledge is disabled by default even for a simulation opportunity', async () => {
  let difyCalls = 0;
  const result = await runSalesAssist(simulationContext(), {
    now: FIXED_NOW,
    runDify: async () => { difyCalls += 1; return {}; }
  });
  assert.equal(result.status, 'needs_source');
  assert.equal(difyCalls, 0);
});

test('simulation switch never enables fixture knowledge for real or missing environments', async () => {
  for (const environment of ['real', undefined]) {
    let difyCalls = 0;
    const input = simulationContext({ environment });
    const result = await runSalesAssist(input, {
      now: FIXED_NOW,
      allowSimulationKnowledge: true,
      runDify: async () => { difyCalls += 1; return {}; }
    });
    assert.equal(result.status, 'needs_source', String(environment));
    assert.equal(difyCalls, 0, String(environment));
  }
});

test('simulation knowledge rejects every non-fixture product version', async () => {
  let difyCalls = 0;
  const result = await runSalesAssist(simulationContext({
    product_scope: { product_id: 'fixture-product', product_version: 'fixture-v2' }
  }), {
    now: FIXED_NOW,
    allowSimulationKnowledge: true,
    runDify: async () => { difyCalls += 1; return {}; }
  });
  assert.equal(result.status, 'needs_source');
  assert.equal(difyCalls, 0);
});

test('explicit simulation switch admits only the exact isolated fixture with its fixed citation', async () => {
  let payload;
  const runDify = simulationDify();
  const result = await runSalesAssist(simulationContext(), {
    now: FIXED_NOW,
    allowSimulationKnowledge: true,
    runDify: async value => {
      payload = value;
      return runDify(value);
    }
  });
  assert.equal(result.status, 'draft_ready');
  assert.equal(result.review_required, true);
  assert.deepEqual(result.citations.map(item => `${item.document_id}#${item.location}`), [
    'fixture-terms-v1#交费期测试段落'
  ]);
  const [evidence] = JSON.parse(payload.inputs.knowledge_json);
  assert.deepEqual({
    product_id: evidence.product_id,
    product_version: evidence.product_version,
    scope: evidence.scope,
    lifecycle_status: evidence.lifecycle_status,
    index_status: evidence.index_status,
    verification_status: evidence.verification_status,
    customer_use: evidence.customer_use,
    citation_id: evidence.citation_id
  }, {
    product_id: 'fixture-product',
    product_version: 'fixture-v1',
    scope: 'new_consultation',
    lifecycle_status: 'active',
    index_status: 'ready',
    verification_status: 'business_verified',
    customer_use: 'approved_for_simulation',
    citation_id: 'fixture-terms-v1#交费期测试段落'
  });
});

test('simulation approval rejects altered source or citation metadata', async () => {
  const [fixture] = await loadSimulationKnowledge();
  const chunk = fixture.chunks[0];
  assert.equal(knowledgeTest.approvedSimulationChunk(fixture, chunk, true), true);
  assert.equal(knowledgeTest.approvedSimulationChunk({
    ...fixture,
    source: { ...fixture.source, label: '伪造来源' }
  }, chunk, true), false);
  assert.equal(knowledgeTest.approvedSimulationChunk(fixture, {
    ...chunk,
    location: '伪造段落'
  }, true), false);
});

test('global simulation knowledge answers public process questions without a product version', async () => {
  const result = await retrieveKnowledge({
    query: '公司统一的保单查询流程是什么？',
    interaction_type: 'new_consultation',
    environment: 'simulation',
    knowledge_scope: 'global',
    product_scope: {},
    as_of: '2026-09-23'
  }, { allowSimulationKnowledge: true, now: FIXED_NOW });
  assert.equal(result.evidence_status, 'ready');
  assert.equal(result.documents[0].document_id, 'global-service-process-v1');
  assert.equal(result.documents[0].product_id, 'GLOBAL');
});

test('global simulation knowledge is never admitted in a real environment', async () => {
  const result = await retrieveKnowledge({
    query: '你能保证我一定能通过核保吗？',
    interaction_type: 'new_consultation',
    environment: 'real',
    knowledge_scope: 'global',
    product_scope: {},
    as_of: '2026-09-23'
  }, { allowSimulationKnowledge: true, now: FIXED_NOW });
  assert.equal(result.evidence_status, 'not_found');
  assert.equal(result.documents.length, 0);
});

test('product knowledge still requires an exact product version after enabling global knowledge', async () => {
  const result = await retrieveKnowledge({
    query: '这款可以选几年交费？',
    interaction_type: 'new_consultation',
    environment: 'simulation',
    product_scope: {},
    as_of: '2026-09-23'
  }, { documents: [document()], now: FIXED_NOW });
  assert.equal(result.evidence_status, 'not_found');
  assert.ok(result.rejected.some(item => item.reason === 'missing_product_version'));
});

test('source-backed draft exposes only citations selected from retrieved evidence', async () => {
  const result = await runSalesAssist(context(), dependencies());
  assert.equal(result.status, 'draft_ready');
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], {
    document_id: 'terms-v1',
    version: 'v1',
    location: '交费期',
    excerpt: '测试产品可选3年交；该内容仅用于自动化测试。',
    title: '测试产品条款',
    source_url: 'https://example.invalid/terms-v1',
    verification_status: 'business_verified',
    customer_use: 'approved'
  });
  assert.equal(result.review_required, true);
});

test('Dify receives the complete metadata required by its deterministic evidence gate', async () => {
  const deps = dependencies();
  const runDify = deps.runDify;
  let payload;
  deps.runDify = async value => {
    payload = value;
    return runDify(value);
  };
  const result = await runSalesAssist(context(), deps);
  assert.equal(result.status, 'draft_ready');
  const [evidence] = JSON.parse(payload.inputs.knowledge_json);
  assert.deepEqual({
    product_id: evidence.product_id,
    product_version: evidence.product_version,
    policy_contract_version: evidence.policy_contract_version,
    scope: evidence.scope,
    lifecycle_status: evidence.lifecycle_status,
    index_status: evidence.index_status,
    verification_status: evidence.verification_status,
    customer_use: evidence.customer_use
  }, {
    product_id: 'product-1',
    product_version: 'v1',
    policy_contract_version: null,
    scope: 'new_consultation',
    lifecycle_status: 'active',
    index_status: 'ready',
    verification_status: 'business_verified',
    customer_use: 'approved'
  });
});

test('a model citation outside retrieved evidence is rejected', async () => {
  const result = await runSalesAssist(context(), dependencies([document()], { citation_ids: ['invented#section'] }));
  assert.equal(result.status, 'invalid_output');
  assert.equal(result.draft, '');
  assert.ok(result.missing_evidence.includes('dify_citation_out_of_scope'));
});

test('overclaim in model output is blocked for human review', async () => {
  const result = await runSalesAssist(context(), dependencies([document()], {
    draft: '这款保证收益，一定适合你。'
  }));
  assert.equal(result.status, 'invalid_output');
  assert.equal(result.draft, '');
  assert.ok(result.missing_evidence.includes('dify_draft_overclaim'));
});

test('marketing opt-out stops new marketing but does not erase an explicit contract service request', async () => {
  const stopped = await runSalesAssist(context({ contact_state: { marketing_opt_out: true } }), dependencies());
  assert.equal(stopped.status, 'stop_marketing');

  const contractDocument = document({
    document_id: 'contract-2024',
    version: 'contract-2024',
    product_version: 'contract-2024',
    policy_contract_versions: ['contract-2024'],
    scopes: ['contract_service'],
    lifecycle_status: 'archived_serviceable',
    topics: ['contract_service'],
    chunks: [{ location: '保单查询', keywords: ['保单', '查资料'], text: '测试旧合同资料只用于对应保单服务。' }]
  });
  const service = await runSalesAssist(context({
    latest_message: '我已经买了，想查这张保单的资料。',
    contact_state: { marketing_opt_out: true, purchased_for_opportunity: true },
    product_scope: { product_version: 'v2', policy_contract_version: 'contract-2024' }
  }), dependencies([contractDocument], {
    draft: '我先按这张旧合同的绑定资料帮您核对，不作新产品推荐。',
    citation_ids: ['contract-2024#保单查询']
  }));
  assert.equal(service.status, 'draft_ready');
  assert.ok(service.risk_flags.includes('marketing_opt_out_service_only'));
  assert.equal(service.citations[0].version, 'contract-2024');
});

test('marketing opt-out stays silent across equivalent customer wording', async () => {
  const acknowledged = await runSalesAssist(context({ latest_message: '不要再给我发了', contact_state: { marketing_opt_out: true } }), dependencies());
  assert.equal(acknowledged.status, 'stop_marketing');
  assert.equal(acknowledged.draft, '');

  const otherWording = await runSalesAssist(context({ latest_message: '别再联系我', contact_state: { marketing_opt_out: true } }), dependencies());
  assert.equal(otherWording.status, 'stop_marketing');
  assert.equal(otherWording.draft, '');
});

test('old-contract service never falls through to a different contract version', async () => {
  const wrongContract = document({
    document_id: 'contract-other',
    version: 'contract-other',
    product_version: 'contract-other',
    policy_contract_versions: ['contract-other'],
    scopes: ['contract_service'],
    lifecycle_status: 'archived_serviceable',
    topics: ['contract_service'],
    chunks: [{ location: '保单查询', keywords: ['保单'], text: '另一个合同版本。' }]
  });
  const result = await runSalesAssist(context({
    latest_message: '我已经买了，想查保单。',
    contact_state: { purchased_for_opportunity: true },
    product_scope: { policy_contract_version: 'contract-2024' }
  }), dependencies([wrongContract]));
  assert.equal(result.status, 'needs_source');
  assert.equal(result.citations.length, 0);
});

test('stale latest-message version returns before retrieval or generation', async () => {
  let calls = 0;
  const result = await runSalesAssist(context({
    context_versions: { latest_message_id: 'message-old', latest_conversation_message_id: 'sales-message-2' }
  }), {
    retrieveKnowledge: async () => { calls += 1; return []; },
    runDify: async () => { calls += 1; return {}; }
  });
  assert.equal(result.status, 'stale_context');
  assert.equal(calls, 0);
});

test('a newer sales record does not invalidate the latest customer question and all versions are preserved', async () => {
  const input = context({
    context_versions: {
      latest_message_id: 'message-1',
      latest_conversation_message_id: 'sales-message-2',
      integration_marker: 'keep-me'
    }
  });
  const result = await runSalesAssist(input, dependencies());
  assert.equal(result.status, 'draft_ready');
  assert.deepEqual(result.context_versions, input.context_versions);
});

test('published Dify branch-specific outputs unwrap to the common AI result contract', () => {
  for (const key of ['draft_result_json', 'blocked_result_json']) {
    const value = __test.unwrapDify({ outputs: { [key]: JSON.stringify({ status: 'needs_source' }) } });
    assert.equal(value.status, 'needs_source');
  }
});

test('a malformed model response is retried once before the draft is sent to human review', async () => {
  let calls = 0;
  const result = await runSalesAssist(context(), {
    now: FIXED_NOW,
    retrieveKnowledge: request => retrieveKnowledge(request, { documents: [document()], now: FIXED_NOW }),
    runDify: async () => {
      calls += 1;
      if (calls === 1) return { workflow_run_id: 'invalid-run', outputs: { draft_result_json: JSON.stringify({
        status: 'human_required', draft: '', citation_ids: [], next_question: null,
        next_action: 'review_invalid_ai_output', risk_flags: ['invalid_dify_output'],
        missing_evidence: ['dify_output_not_json']
      }) } };
      return dependencies().runDify();
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'draft_ready');
  assert.equal(result.trace.workflow_run_id, 'workflow-run-1');
});

test('missing Dify dependency is explicit and never returns a template as AI', async () => {
  const result = await runSalesAssist(context(), {
    now: FIXED_NOW,
    retrieveKnowledge: request => retrieveKnowledge(request, { documents: [document()], now: FIXED_NOW })
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.draft, '');
  assert.equal(result.trace.provider, 'unconfigured');
  assert.ok(result.missing_evidence.includes('dify_not_configured'));
});

test('matching intent bypasses A generation, but a referral source stays ordinary intake', async () => {
  let calls = 0;
  const deps = { runDify: async () => { calls++; }, retrieveKnowledge: async () => { calls++; return []; } };
  const match = await runSalesAssist(context({ latest_message: '帮我推荐哪款合适？' }), deps);
  assert.equal(match.next_action, 'run_product_match');
  assert.equal(calls, 0); assert.equal(match.draft, '');
  const referral = await runSalesAssist(context({ latest_message: '朋友推荐我过来的' }), deps);
  assert.equal(referral.next_action, 'auto_send_safe_intake'); assert.equal(calls, 0);
});

test('service without a bound contract does not fall back to a new product version', async () => {
  let calls = 0;
  const reply = await runSalesAssist(context({ latest_message: '办理续期手续', contact_state: { purchased_for_opportunity: true } }), {
    retrieveKnowledge: async () => { calls++; return []; }
  });
  assert.equal(reply.status, 'needs_source'); assert.equal(calls, 0);
  assert.ok(reply.missing_evidence.includes('policy_contract_version_required'));
});

test('missing formal plan gets a safe customer-facing handoff instead of silence or invented yield', async () => {
  let calls = 0;
  const reply = await runSalesAssist(context({
    latest_message: '这款产品的收益率是多少？现在只有演练资料，没有我的正式计划书。',
    product_scope: { product_id: null, product_version: null, policy_contract_version: null }
  }), {
    retrieveKnowledge: async () => { calls++; return []; },
    runDify: async () => { calls++; return {}; }
  });
  assert.equal(reply.status, 'draft_ready');
  assert.equal(reply.review_required, true);
  assert.equal(reply.next_action, 'sales_review_missing_formal_plan');
  assert.match(reply.draft, /没有.*正式计划书/);
  assert.match(reply.draft, /不能直接给出收益率数字/);
  assert.ok(reply.risk_flags.includes('formal_plan_required'));
  assert.equal(calls, 0);
});

test('Dify receives route/contact state and cannot mix a valid citation with an invented one', async () => {
  const deps = dependencies();
  const runner = deps.runDify;
  deps.runDify = async payload => {
    const data = JSON.parse(payload.inputs.context_json);
    assert.equal(data.conversation_route, 'product_faq');
    assert.equal(data.contact_state.marketing_opt_out, false);
    return runner(payload);
  };
  assert.equal((await runSalesAssist(context(), deps)).status, 'draft_ready');
  const invalid = await runSalesAssist(context(), dependencies([document()], { citation_ids: ['terms-v1#交费期', 'invented#source'], next_action: 'auto_send_safe_intake' }));
  assert.equal(invalid.status, 'invalid_output'); assert.equal(invalid.draft, '');
});

test('invalid context is returned as a structured error', async () => {
  const result = await runSalesAssist({ schema_version: 'wrong' });
  assert.equal(result.schema_version, 'sales-assist.v1');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.missing_evidence, ['unsupported_schema_version']);
});

test('an inbound video lead receives an auto-send-safe next question without inventing product facts', async () => {
  let retrievalCalls = 0; let difyCalls = 0;
  const input = context({ environment: 'real', latest_message: '看你们视频过来的' });
  const result = await runSalesAssist(input, {
    retrieveKnowledge: async () => { retrievalCalls++; return []; },
    runDify: async () => { difyCalls++; return {}; }
  });
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /已经记下.*视频/);
  assert.match(result.draft, /请问您想给自己还是家人了解/);
  assert.equal(result.next_action, 'auto_send_safe_intake');
  assert.equal(result.review_required, false);
  assert.equal(result.citations.length, 0);
  assert.equal(result.trace.provider, 'lead-intake-rule');
  assert.equal(retrievalCalls, 0);
  assert.equal(difyCalls, 0);
});

test('a text-only contact preference is acknowledged before the next single intake question', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我先了解一下，不想接电话' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /文字聊/);
  assert.match(result.draft, /不打电话/);
  assert.match(result.draft, /给谁/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 1);
  assert.equal(result.next_action, 'auto_send_safe_intake');
});

test('an unsure browser is invited to start from the problem instead of being pushed to a product', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '先看看，我也不知道要买什么' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /不用急着选产品/);
  assert.match(result.draft, /最想解决的问题/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 1);
});

test('a busy customer is acknowledged without another question', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我现在很忙，晚点说' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /您先忙/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('an emoji-only customer receives a lightweight greeting without inferred intent', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '🙂' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /方便时随时/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('a customer who only wants to ask a question is not forced through profiling first', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我只想问个问题，不一定买' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /先直接说想问的问题/);
  assert.doesNotMatch(result.draft, /给谁买/);
});

test('a generic product overview stays at safe need categories without inventing product facts', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '你们有哪些产品？', product_scope: { product_id: null, product_version: null } }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /养老、孩子教育、长期储备/);
  assert.equal(result.review_required, false);
  assert.equal(result.citations.length, 0);
});

test('a repeated budget deferral returns to the requested receiving-time topic', async () => {
  const result = await runSalesAssist(context({
    environment: 'real',
    latest_message: '预算还是先不说，先讲讲什么时候开始领取。',
    product_scope: { product_id: null, product_version: null },
    recent_messages: [
      { role: 'customer', text: '预算先不说，我想先了解什么时候开始领。' },
      { role: 'sales', text: '没关系。那每年大概准备投入多少？', status: 'manually_confirmed_sent' }
    ]
  }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /预算先不问/);
  assert.match(result.draft, /什么时候开始领取/);
  assert.doesNotMatch(result.draft, /给谁买/);
  assert.equal(result.review_required, true);
});

test('a joint-decision pause is acknowledged without another discovery question', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我先跟爱人商量' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /先和爱人商量/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('conflicting ages stop progression and ask for one confirmation', async () => {
  for (const latestMessage of [
    '客户一处说59岁，另一处说61岁',
    '我妈妈今年59岁……不对，我又看到一处写的61岁，我也不确定哪个对。'
  ]) {
    const result = await runSalesAssist(context({ environment: 'real', latest_message: latestMessage }), {});
    assert.equal(result.status, 'draft_ready');
    assert.match(result.draft, /59岁和61岁/);
    assert.match(result.draft, /正确年龄/);
    assert.equal(result.next_action, 'confirm_conflicting_age');
    assert.equal((result.draft.match(/[？?]/g) || []).length, 1);
  }
});

test('ages belonging to different family members are not treated as one conflict', async () => {
  const result = await runSalesAssist(context({
    environment: 'real',
    latest_message: '我今年38岁，先给自己看。改一下，这次是给我妈妈买，她59岁。'
  }), {});
  assert.doesNotMatch(result.draft, /两种记录|正确年龄/);
  assert.equal(result.next_action, 'review_insured_person_switch');
});

test('a repeated liquidity concern receives a safe acknowledgement instead of silence', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '还是老问题，我担心中途用钱。', product_scope: { product_id: null, product_version: null } }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /中途可能要用钱/);
  assert.match(result.draft, /流动性/);
  assert.match(result.draft, /尚未解决/);
  assert.match(result.draft, /不另建/);
  assert.equal(result.review_required, true);
});

test('a returning customer resumes confirmed mother retirement context without repeating it', async () => {
  const result = await runSalesAssist(context({
    environment: 'real', latest_message: '之前那个再聊聊。',
    product_scope: { product_id: null, product_version: null },
    recent_messages: [
      { role: 'customer', text: '上次聊的是给妈妈做养老，每年预算2万元，我说回去商量。' },
      { role: 'sales', text: '好的，我给您保留已确认的信息。' },
      { role: 'customer', text: '之前那个再聊聊。' }
    ]
  }), {});
  assert.match(result.draft, /给妈妈做养老/);
  assert.match(result.draft, /每年预算约2万元/);
  assert.match(result.draft, /不重复再问/);
  assert.match(result.draft, /妈妈现在大概多大/);
});

test('a purchased retirement policy and a new education inquiry stay separate', async () => {
  const result = await runSalesAssist(context({
    environment: 'real', latest_message: '客户已买养老产品，又来咨询孩子教育',
    product_scope: { product_id: null, product_version: null }
  }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /养老保单.*已购服务/);
  assert.match(result.draft, /孩子教育.*新的独立需求/);
  assert.match(result.draft, /不会对原养老产品重复营销/);
});

test('a three-to-five-year liquidity concern is acknowledged as a strong constraint', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我不想长期锁住，三五年可能要用钱。' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /流动性作为强约束/);
  assert.doesNotMatch(result.draft, /想给谁买/);
  assert.equal(result.next_action, 'record_liquidity_constraint');
});

test('budget purpose is explained without forcing another answer', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '为什么要问我的预算？' }), {});
  assert.match(result.draft, /避免.*压力过大/);
  assert.match(result.draft, /区间|先不回答/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('marketing concern is acknowledged without treating it as a completed opt-out', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我怕被你们一直推销' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /不会强行推销/);
  assert.match(result.draft, /停止联系/);
  assert.notEqual(result.status, 'stop_marketing');
});

test('complex explanation feedback stops discovery and simplifies the response', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '你说得太复杂了' }), {});
  assert.match(result.draft, /简单说/);
  assert.match(result.draft, /最想先确认/);
  assert.doesNotMatch(result.draft, /给谁买/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 1);
});

test('generic liquidity concern is acknowledged with concrete evidence checks', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '我对流动性有些担心，不想急着定方案。' }), {});
  assert.match(result.draft, /先不急着定方案/);
  assert.match(result.draft, /保单贷款、减保或部分领取/);
  assert.equal(result.review_required, true);
});

test('a natural payment-term question routes to product evidence instead of restarting intake', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation', latest_message: '安心储备可以选择几年交？',
    product_scope: { product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2' }
  }), dependencies([document({
    product_id: 'practice-savings-endowment',
    product_version: 'practice-2026-09-v2'
  })]));
  assert.equal(result.status, 'draft_ready');
  assert.ok(result.citations.length > 0);
  assert.doesNotMatch(result.draft, /想给谁买/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('E01: an exact product scope retrieves only the current product version and cites it', async () => {
  let evidence;
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '安心储备两全保险可以选哪些交费期？',
    product_scope: { product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2' }
  }), {
    now: FIXED_NOW,
    allowSimulationKnowledge: true,
    runDify: async payload => {
      evidence = JSON.parse(payload.inputs.knowledge_json);
      return {
        workflow_run_id: 'workflow-e01',
        outputs: {
          status: 'draft_ready',
          draft: '安心储备两全保险可选3年交、5年交或10年交，演练版本里就这三个。',
          citation_ids: ['practice-savings-endowment-terms#投保范围与交费期'],
          next_question: null,
          next_action: 'sales_review',
          risk_flags: [],
          missing_evidence: [],
          provider: 'mock-dify'
        }
      };
    }
  });
  assert.equal(result.status, 'draft_ready');
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every(item => item.product_id === 'practice-savings-endowment'
    && item.product_version === 'practice-2026-09-v2'));
  assert.ok(result.citations.some(item => item.document_id === 'practice-savings-endowment-terms'
    && item.version === 'practice-2026-09-v2'));
  assert.match(result.draft, /^根据这款产品当前版本的已核验条款/);
  assert.match(result.draft, /3年交、5年交或10年交/);
  assert.match(result.draft, /当前已核验资料/);
  assert.doesNotMatch(result.draft, /演练|模拟|fixture|simulation/i);
});

test('all customer-visible drafts remove internal evaluation environment terms', () => {
  const cleaned = __test.sanitizeCustomerDraft('这是模拟资料，fixture 里的测试版本。');
  assert.doesNotMatch(cleaned, /演练|模拟|测试|fixture|simulation/i);
  assert.match(cleaned, /当前已核验资料/);
});

test('E06: a near-match product name asks for exact identity instead of guessing terms', async () => {
  let retrievalCalls = 0;
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '那个“安心储蓄”可以选几年交？',
    product_scope: { product_id: null, product_version: null, policy_contract_version: null }
  }), {
    now: FIXED_NOW,
    retrieveKnowledge: async () => { retrievalCalls += 1; return []; }
  });
  assert.equal(result.status, 'draft_ready');
  assert.equal(retrievalCalls, 0);
  assert.match(result.draft, /不.*猜具体产品/);
  assert.match(result.draft, /产品全称/);
  assert.doesNotMatch(result.draft, /3年交|5年交|10年交/);
  assert.equal(result.next_action, 'confirm_product_identity');
});

test('E07: a customer-specific future amount requires a formal plan and never estimates', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '安心储备每年交2万元，十年后具体能领多少？',
    product_scope: { product_id: null, product_version: null, policy_contract_version: null },
    verified_plan: null
  }), { now: FIXED_NOW, allowSimulationKnowledge: true });
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /没有.*正式计划书/);
  assert.match(result.draft, /不能.*类似案例估算/);
  assert.ok(result.citations.some(item => item.document_id === 'global-compliance-v1'
    && item.location === '保证内容与演示内容边界'));
  assert.equal(result.next_action, 'sales_review_missing_formal_amount');
  assert.ok(result.missing_evidence.includes('formal_plan_required'));
});

test('E09: a policy lookup question uses global service knowledge without product binding', async () => {
  let request;
  let evidence;
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '请问保单要在哪里查询？',
    product_scope: { product_id: null, product_version: null, policy_contract_version: null }
  }), {
    now: FIXED_NOW,
    allowSimulationKnowledge: true,
    retrieveKnowledge: async value => {
      request = value;
      return retrieveKnowledge(value, { documents: await loadSimulationKnowledge(), now: FIXED_NOW, allowSimulationKnowledge: true });
    },
    runDify: async payload => {
      evidence = JSON.parse(payload.inputs.knowledge_json);
      return {
        workflow_run_id: 'workflow-e09',
        outputs: {
          status: 'draft_ready',
          draft: '查询保单前需要先核验您的身份和保单归属，再由销售或服务人员通过公司授权渠道查询。',
          citation_ids: ['global-service-process-v1#保单查询通用流程'],
          next_question: null,
          next_action: 'sales_review',
          risk_flags: [],
          missing_evidence: [],
          provider: 'mock-dify'
        }
      };
    }
  });
  assert.equal(request.knowledge_scope, 'global');
  assert.deepEqual(request.product_scope, {
    product_id: null, product_version: null, policy_contract_version: null, as_of: '2026-09-23'
  });
  assert.ok(evidence.every(item => item.product_id === 'GLOBAL'));
  assert.equal(result.status, 'draft_ready');
  assert.ok(result.citations.some(item => item.document_id === 'global-service-process-v1'));
  assert.match(result.draft, /公司授权渠道/);
});

test('an evidence-backed product fact answer removes a mechanical trailing sales question', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation', latest_message: '安心储备可以选择几年交？',
    product_scope: { product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2' }
  }), dependencies([document({
    product_id: 'practice-savings-endowment',
    product_version: 'practice-2026-09-v2'
  })], {
    draft: '可以选择3年交、5年交或10年交。你大概想放多久呀？',
    next_question: '你大概想放多久呀？'
  }));
  assert.equal(result.draft, '根据这款产品当前版本的已核验条款，可以选择3年交、5年交或10年交。');
  assert.equal(result.next_question, null);
});

test('a product fact answer removes a question plus the sales tail after it', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation', latest_message: '安心储备可以选择几年交？',
    product_scope: { product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2' }
  }), dependencies([document({
    product_id: 'practice-savings-endowment', product_version: 'practice-2026-09-v2'
  })], {
    draft: '安心储备现在可以3年交、5年交或10年交。你心里大概想放多久呀？我好帮你看看哪种交法更顺手。',
    next_question: '你心里大概想放多久呀？'
  }));
  assert.equal(result.draft, '根据这款产品当前版本的已核验条款，安心储备现在可以3年交、5年交或10年交。');
  assert.equal(result.next_question, null);
});

test('question fatigue receives an apology and no further discovery question', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '你怎么老问我问题？' }), {});
  assert.match(result.draft, /抱歉/);
  assert.match(result.draft, /停止追问/);
  assert.equal((result.draft.match(/[？?]/g) || []).length, 0);
});

test('dialect typo confirms an uncertain age instead of silently normalizing it', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '给俺妈买，五十巴岁，一年两万，咋整？' }), {});
  assert.match(result.draft, /给妈妈/);
  assert.match(result.draft, /都先不替您确定/);
  assert.match(result.draft, /确认.*年龄/);
  assert.doesNotMatch(result.draft, /预算约2万/);
  assert.doesNotMatch(result.draft, /想给谁买/);
});

test('a reference to a prior child need resumes confirmed related history', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation', latest_message: '之前为孩子问的那个再看看',
    related_opportunities: [{ opportunity_id: 'old-education', purpose: '孩子教育', summary: '孩子8岁，准备大学教育金，10年后使用。' }]
  }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /不用从头再说/);
  assert.match(result.draft, /孩子8岁/);
  assert.equal(result.next_action, 'resume_related_opportunity');
});

test('a three-year need blocks a named long-term savings product', async () => {
  const result = await runSalesAssist(context({ environment: 'simulation', latest_message: '我38岁，想给自己做长期储备，每年预算2万元，但这笔钱三年内可能会用到。请帮我看看是否适合安心储备？' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /长期储备类产品可能不适合/);
  assert.match(result.draft, /三年内可用/);
  assert.equal(result.next_action, 'sales_review_liquidity_constraint');
});

test('a generic mid-term liquidity question uses approved global evidence when available', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation', latest_message: '中途急用钱怎么办？',
    product_scope: { product_id: null, product_version: null, policy_contract_version: null }
  }), { allowSimulationKnowledge: true });
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /保单贷款、减保或部分领取/);
  assert.match(result.draft, /影响保额、保障、现金价值或合同效力/);
  assert.equal(result.citations[0].document_id, 'global-service-process-v1');
});

test('an early retirement need receives the next discovery question before product matching', async () => {
  const input = context({ environment: 'real', latest_message: '我想给自己做养老准备', recent_messages: [{ role: 'customer', text: '我是看抖音视频过来的' }] });
  const result = await runSalesAssist(input, {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /养老安排/);
  assert.match(result.draft, /多大/);
  assert.equal(result.next_action, 'auto_send_safe_intake');
  assert.equal(result.review_required, false);
  assert.equal(result.trace.provider, 'lead-intake-rule');
});

test('lead intake asks one missing field at a time and awaits explicit matching intent when complete', async () => {
  const prior = [
    { role: 'customer', text: '我是看抖音视频过来的' },
    { role: 'customer', text: '我想给自己做养老准备' }
  ];
  const budgetQuestion = await runSalesAssist(context({ environment: 'real', latest_message: '我45岁', recent_messages: prior }), {});
  assert.equal(budgetQuestion.status, 'draft_ready');
  assert.match(budgetQuestion.draft, /每年.*预算/);
  assert.equal(budgetQuestion.next_action, 'auto_send_safe_intake');
  const horizonQuestion = await runSalesAssist(context({
    environment: 'real',
    latest_message: '每年预算2万元',
    recent_messages: [...prior, { role: 'customer', text: '我45岁' }]
  }), {});
  assert.equal(horizonQuestion.status, 'draft_ready');
  assert.match(horizonQuestion.draft, /多少年内/);
  const complete = await runSalesAssist(context({
    environment: 'real',
    latest_message: '这笔钱10年内不会用到',
    recent_messages: [...prior, { role: 'customer', text: '我45岁' }, { role: 'customer', text: '每年预算2万元' }]
  }), {});
  assert.equal(complete.status, 'needs_information');
  assert.equal(complete.draft, '');
  assert.equal(complete.next_action, 'await_product_match_intent');
  assert.equal(complete.review_required, true);
});

test('vague savings and qualitative income are acknowledged without inventing a need or amount', async () => {
  const vague = await runSalesAssist(context({ environment: 'real', latest_message: '就是想先放着，以后再说。' }), {});
  assert.match(vague.draft, /长期储备方向观察/);
  assert.match(vague.draft, /不.*定成养老或教育/);
  assert.equal(vague.next_action, 'record_deferred_savings_observation');

  const income = await runSalesAssist(context({ environment: 'real', latest_message: '家里收入还行，不方便说数字。' }), {});
  assert.match(income.draft, /定性说明/);
  assert.match(income.draft, /不猜具体收入数字/);
  assert.match(income.draft, /不.*高净值/);
  assert.equal(income.next_action, 'record_qualitative_income_observation');
});

test('switching the insured person to mother pauses matching and isolates profiles', async () => {
  const result = await runSalesAssist(context({
    environment: 'real',
    latest_message: '改一下，这次主要是给妈妈做养老，她59岁。'
  }), {});
  assert.match(result.draft, /购买对象更正为妈妈/);
  assert.match(result.draft, /妈妈59岁/);
  assert.match(result.draft, /原先记录的信息会保留，但不用于这次需求/);
  assert.doesNotMatch(result.draft, /爸爸/);
  assert.match(result.draft, /人物信息确认清楚后.*产品匹配/);
  assert.equal(result.next_action, 'review_insured_person_switch');
  assert.equal(result.review_required, true);
});

test('source gaps produce useful safe replies instead of blank product answers', async () => {
  const cases = [
    {
      message: '领取金额是不是保证的？',
      draft: [/合同明确约定/, /演示内容/, /不能确认具体金额/],
      action: 'sales_review_guarantee_scope',
      missing: 'formal_plan_required'
    },
    {
      message: '中途急用钱怎么办？',
      draft: [/具体产品合同/, /不能承诺.*没有损失/],
      action: 'sales_review_liquidity_terms',
      missing: 'policy_contract_version_required'
    },
    {
      message: '客户使用产品的俗称或说错一个字',
      draft: [/不.*猜产品/, /产品全称/],
      action: 'confirm_product_identity',
      missing: 'exact_product_name_required'
    },
    {
      message: '一个知识库中没有的具体金额',
      draft: [/没有这个具体金额/, /不能.*估算/, /正式计划书/],
      action: 'sales_review_missing_formal_amount',
      missing: 'formal_plan_required'
    },
    {
      message: '客户要求查询合同原文',
      draft: [/可追溯的正式条款/, /不能用 FAQ/],
      action: 'sales_send_official_contract_source',
      missing: 'policy_contract_version_required'
    }
  ];
  for (const item of cases) {
    const result = await runSalesAssist(context({
      environment: 'real', latest_message: item.message,
      product_scope: { product_id: '', product_version: '', policy_contract_version: null }
    }), dependencies([]));
    assert.equal(result.status, 'draft_ready', item.message);
    for (const pattern of item.draft) assert.match(result.draft, pattern, item.message);
    assert.equal(result.next_action, item.action, item.message);
    assert.ok(result.missing_evidence.includes(item.missing), item.message);
    assert.equal(result.trace.provider, 'source-gap-rule', item.message);
  }
});

test('a guarantee-scope answer cites the approved global compliance boundary', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '领取金额是不是保证的？',
    product_scope: { product_id: '', product_version: '', policy_contract_version: null }
  }), { now: FIXED_NOW, allowSimulationKnowledge: true });
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /合同明确约定/);
  assert.match(result.draft, /演示内容/);
  assert.ok(result.citations.some(item => item.document_id === 'global-compliance-v1'
    && item.location === '保证内容与演示内容边界'));
});

test('high-risk surrender question remains a silent human handoff', async () => {
  const result = await runSalesAssist(context({
    environment: 'real', latest_message: '退保是不是能拿回全部保费？',
    product_scope: { product_id: '', product_version: '', policy_contract_version: null }
  }), dependencies([]));
  assert.equal(result.status, 'human_required');
  assert.equal(result.draft, '');
  assert.equal(result.next_action, 'route_to_human_owner');
});

test('a claim guarantee question gives only a qualified explanation and requires human review', async () => {
  const result = await runSalesAssist(context({
    environment: 'real', latest_message: '这个病一定能赔吗？',
    product_scope: { product_id: '', product_version: '', policy_contract_version: null }
  }), dependencies([]));
  assert.equal(result.status, 'human_required');
  assert.match(result.draft, /不能提前保证/);
  assert.match(result.draft, /合同、案件事实.*正式审核结果/);
  assert.equal(result.next_action, 'human_review_claim_coverage');
  assert.ok(result.risk_flags.includes('claim_outcome_requires_human_review'));
});

test('an unverified near-match product name is blocked before cross-product comparison', async () => {
  const result = await runSalesAssist(context({
    environment: 'simulation',
    latest_message: '启航成长教育年金和领享年年养老年金有什么区别？',
    product_scope: { product_id: '', product_version: '', policy_contract_version: null }
  }), { now: FIXED_NOW, allowSimulationKnowledge: true });
  assert.equal(result.status, 'needs_source');
  assert.match(result.draft, /领享年年/);
  assert.match(result.draft, /颐享年年养老年金/);
  assert.match(result.draft, /核对.*产品全称/);
  assert.equal(result.next_action, 'confirm_product_identity_before_comparison');
  assert.equal(result.citations.length, 0);
});

test('an identity question is answered transparently instead of impersonating a person', async () => {
  const result = await runSalesAssist(context({ environment: 'real', latest_message: '你是机器人吗？' }), {});
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /AI工具.*整理和核对资料/);
  assert.match(result.draft, /具体沟通和内容确认由我本人负责/);
  assert.doesNotMatch(result.draft, /AI(?:助手)?.{0,8}(?:整理|生成)回复/);
});

test('an annual budget answer visibly carries forward the sales question', async () => {
  const result = await runSalesAssist(context({
    latest_message: '两万左右吧。',
    recent_messages: [
      { role: 'sales', text: '您每年大概可以投入多少？' },
      { role: 'customer', text: '两万左右吧。' }
    ],
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /每年预算大约2万元，我先记下了/);
  assert.match(result.draft, /给自己准备，还是给家人准备/);
  assert.equal(result.next_question, '您这次主要想给自己准备，还是给家人准备呢？');
  assert.doesNotMatch(result.draft, /不会当成每年领取/);
  assert.doesNotMatch(result.draft, /我是太保的销售经理/);
});

test('an annual budget answer asks the next missing field instead of repeating known context', async () => {
  const result = await runSalesAssist(context({
    latest_message: '两万左右吧。',
    recent_messages: [
      { role: 'customer', text: '想给妈妈准备养老。' },
      { role: 'sales', text: '您每年大概可以投入多少？' },
      { role: 'customer', text: '两万左右吧。' }
    ],
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.match(result.draft, /每年预算大约2万元/);
  assert.match(result.draft, /做准备的人现在大概多大/);
  assert.doesNotMatch(result.draft, /给自己准备|养老、孩子教育/);
});

test('a desired annual income is acknowledged without treating it as premium or a promise', async () => {
  const result = await runSalesAssist(context({
    latest_message: '我想每年能拿两万。',
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /每年领取约2万元/);
  assert.match(result.draft, /不是年交保费预算/);
  assert.match(result.draft, /是否能实现还需/);
});

test('a corrected insured person is explicitly acknowledged in the visible reply', async () => {
  const result = await runSalesAssist(context({
    latest_message: '刚才说错了，是给妈妈。',
    recent_messages: [
      { role: 'customer', text: '给爸爸买。' },
      { role: 'customer', text: '刚才说错了，是给妈妈。' }
    ],
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /购买对象更正为妈妈/);
  assert.match(result.draft, /原先爸爸的信息会保留，但不用于这次需求/);
});

test('a self-to-mother correction names self only when prior evidence supports it', async () => {
  const result = await runSalesAssist(context({
    latest_message: '改一下，其实这次主要是给我妈妈买，她59岁。',
    recent_messages: [
      { role: 'customer', text: '我今年38岁，先想给自己看看养老。' },
      { role: 'sales', text: '好的，我先按您本人记录。' },
      { role: 'customer', text: '改一下，其实这次主要是给我妈妈买，她59岁。' }
    ],
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.match(result.draft, /原先您本人的信息会保留，但不用于这次需求/);
  assert.doesNotMatch(result.draft, /爸爸/);
});

test('a family-member mention is not invented as the previous insured person', async () => {
  const result = await runSalesAssist(context({
    latest_message: '改一下，这次主要是给我妈妈买，她59岁。',
    recent_messages: [
      { role: 'customer', text: '我爸爸建议我给妈妈做养老规划。' },
      { role: 'customer', text: '改一下，这次主要是给我妈妈买，她59岁。' }
    ],
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.match(result.draft, /原先记录的信息会保留，但不用于这次需求/);
  assert.doesNotMatch(result.draft, /原先爸爸/);
});

test('a health-discussion deferral is acknowledged without a health conclusion or another question', async () => {
  const result = await runSalesAssist(context({
    latest_message: '健康方面等后面真要买再聊。',
    product_scope: { product_id: '', product_version: '' }
  }), dependencies([]));
  assert.equal(result.status, 'draft_ready');
  assert.match(result.draft, /健康方面我们先不展开/);
  assert.match(result.draft, /不替您补写任何健康结论/);
  assert.equal(result.next_question, null);
  assert.doesNotMatch(result.draft, /您有什么病|健康状况怎么样/);
});

test('a direct human-contact request gets only a short handoff acknowledgement', async () => {
  const result = await runSalesAssist(context({ latest_message: '客户主动要求人工联系', contact_state: { human_handoff: true } }), dependencies());
  assert.equal(result.status, 'human_required');
  assert.equal(result.draft, '好的，已通知人工专员接手。');
  assert.equal(result.next_action, 'route_to_human_owner');
});

test('approved experience is retained but does not append a question to a complete product fact answer', async () => {
  const deps = dependencies([document()], { next_question: null });
  let request;
  deps.retrieveExperiences = async value => {
    request = value;
    return {
      status: 'ready',
      experiences: [{
        experience_id: 'experience-1',
        approval_status: 'approved',
        version: '1',
        source_review_id: 'review-1',
        content: '交费期问题可以用一个偏好问题收窄。',
        follow_up_suggestion: '您更倾向一次交清，还是分几年安排？'
      }]
    };
  };
  const input = context({ environment: 'real' });
  const result = await runSalesAssist(input, deps);
  assert.deepEqual(request, {
    workspace_id: 'demo',
    environment: 'real',
    product_scope: { ...input.product_scope },
    query: input.latest_message,
    interaction_type: 'new_consultation'
  });
  assert.equal(result.next_question, null);
  assert.deepEqual(result.trace.experience_ids, ['experience-1']);
  assert.deepEqual(result.experience_suggestions, [{
    experience_id: 'experience-1',
    version: '1',
    source_review_id: 'review-1',
    content: '交费期问题可以用一个偏好问题收窄。'
  }]);
  assert.equal(result.draft, '根据这款产品当前版本的已核验条款列出了3年交，其他选项还要继续核对。');
});

test('experience retrieval is skipped when no approved product evidence exists', async () => {
  let experienceCalls = 0;
  const result = await runSalesAssist(context({ environment: 'real' }), {
    now: FIXED_NOW,
    retrieveKnowledge: async () => ({ documents: [], citations: [], review_candidates: [], rejected: [] }),
    retrieveExperiences: async () => { experienceCalls += 1; return []; },
    runDify: async () => { throw new Error('must not run'); }
  });
  assert.equal(result.status, 'needs_source');
  assert.equal(experienceCalls, 0);
});

test('experience failure degrades safely and does not block an evidence-backed draft', async () => {
  const deps = dependencies();
  deps.retrieveExperiences = async () => { throw new Error('storage unavailable'); };
  const result = await runSalesAssist(context({ environment: 'real' }), deps);
  assert.equal(result.status, 'draft_ready');
  assert.ok(result.risk_flags.includes('experience_retrieval_failed'));
  assert.equal(result.trace.experience_status, 'error');
});

test('product fact policy removes model and unsafe experience follow-up questions', async () => {
  const deps = dependencies([document()], { next_question: '模型已有一个问题？' });
  deps.retrieveExperiences = async () => ({
    status: 'ready',
    experiences: [{ experience_id: 'experience-1', approval_status: 'approved', follow_up_suggestion: '保证收益，买吗？现在买吗？' }]
  });
  const result = await runSalesAssist(context({ environment: 'real' }), deps);
  assert.equal(result.next_question, null);
  assert.equal(result.citations.length, 1);
});

function confirmedMatch(input = context(), overrides = {}) {
  return {
    schema_version: 'confirmed-product-match.v1',
    recommendation_id: 'recommendation-1',
    candidate_id: 'candidate-1',
    product_id: input.product_scope.product_id,
    product_version: input.product_scope.product_version,
    status: 'human_confirmed',
    selected_payment_years: 3,
    reasons: ['经确定性规则校验可进入讨论'],
    citations: [{ citation_id: 'terms-v1#交费期' }],
    case_references: [{ case_id: 'case-1', outcome: 'success', reason: '仅供沟通参考' }],
    explanation: '人工已确认该候选可进入讨论，不代表承保。',
    context_versions: { ...input.context_versions },
    catalog_fingerprint: 'sha256:catalog-1',
    reviewer: 'sales-user-1',
    confirmed_at: '2026-09-23T05:00:00.000Z',
    ...overrides
  };
}

test('a current human-confirmed product match is sanitized into the existing Dify context only', async () => {
  const input = context({ environment: 'real' });
  input.confirmed_product_match = confirmedMatch(input, { reasons: [
    { code: 'payment_years_supported', message: '已确认交费期在支持列表中。', citation_ids: ['terms-v1#交费期'] }
  ] });
  const deps = dependencies();
  const runDify = deps.runDify;
  let payload;
  deps.runDify = async value => { payload = value; return runDify(value); };
  const result = await runSalesAssist(input, deps);
  assert.equal(result.status, 'draft_ready');
  assert.deepEqual(Object.keys(payload.inputs), ['schema_version', 'interaction_type', 'latest_message', 'context_json', 'knowledge_json']);
  const sent = JSON.parse(payload.inputs.context_json).confirmed_product_match;
  assert.equal(sent.schema_version, 'confirmed-product-match.v1');
  assert.equal(sent.status, 'human_confirmed');
  assert.equal(sent.candidate_id, 'candidate-1');
  assert.deepEqual(sent.context_versions, input.context_versions);
  assert.deepEqual(sent.reasons, input.confirmed_product_match.reasons);
});

test('a confirmed product match remains valid after a normal new conversation message', async () => {
  const acceptedAt = context({ environment: 'real' });
  const input = context({
    environment: 'real',
    latest_message_id: 'message-2',
    latest_message: '这款产品可以选几年交费？',
    context_versions: { latest_message_id: 'message-2', latest_conversation_message_id: 'message-2' }
  });
  input.confirmed_product_match = confirmedMatch(acceptedAt);
  const deps = dependencies();
  const runDify = deps.runDify;
  let sent;
  deps.runDify = async value => { sent = JSON.parse(value.inputs.context_json); return runDify(value); };
  const result = await runSalesAssist(input, deps);
  assert.equal(result.status, 'draft_ready');
  assert.equal(sent.confirmed_product_match.recommendation_id, 'recommendation-1');
  assert.ok(!result.risk_flags.includes('invalid_confirmed_product_match'));
});

test('an expired or product-mismatched confirmed match is omitted without breaking ordinary answers', async () => {
  for (const changed of [
    { context_versions: { customer_revision: 999, opportunity_revision: 1, profile_version: 1, latest_message_id: 'message-1', latest_conversation_message_id: 'message-1' } },
    { product_version: 'other-version' },
    { status: 'proposed' }
  ]) {
    const input = context({ environment: 'real' });
    input.confirmed_product_match = confirmedMatch(input, changed);
    const deps = dependencies();
    const runDify = deps.runDify;
    let sent;
    deps.runDify = async value => { sent = JSON.parse(value.inputs.context_json); return runDify(value); };
    const result = await runSalesAssist(input, deps);
    assert.equal(result.status, 'draft_ready');
    assert.equal(sent.confirmed_product_match, undefined);
    assert.ok(result.risk_flags.includes('invalid_confirmed_product_match'));
    assert.ok(result.missing_evidence.some(item => item.startsWith('confirmed_product_match_')));
  }
});
