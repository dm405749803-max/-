import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductMatch } from '../../ai/product-match.mjs';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createRecommendationService } from '../../server/recommendations.mjs';

function matchContext(overrides = {}) {
  const base = {
    schema_version: 'sales-assist.v1', workspace_id: 'fixture', customer_id: 'customer',
    opportunity_id: 'need', environment: 'simulation', latest_message_id: 'm1',
    latest_message: '请按已确认画像核对候选。',
    contact_state: { marketing_opt_out: false, human_handoff: false, purchased_for_opportunity: false },
    need_profile: { purpose: 'retirement', budget_amount: 20000, budget_currency: 'CNY', person_ids: ['mother'] },
    confirmed_facts: [{ field: 'age', value: 58, person_id: 'mother', status: 'confirmed' }],
    context_versions: { customer_revision: 1, opportunity_revision: 1, profile_version: 1, latest_message_id: 'm1' }
  };
  return { ...base, ...overrides, contact_state: { ...base.contact_state, ...(overrides.contact_state || {}) },
    need_profile: { ...base.need_profile, ...(overrides.need_profile || {}) },
    context_versions: { ...base.context_versions, ...(overrides.context_versions || {}) } };
}

function candidate(id, status = 'eligible_for_discussion', overrides = {}) {
  return {
    candidate_id: id, product_id: `product-${id}`, product_version: 'fixture-v1', status,
    reasons: [{ code: `${id}-rule`, message: `${id}由确定性规则判定`, citation_ids: [`source-${id}#rules`] }],
    missing_fields: [], questions: [], allowed_payment_years: [3, 5],
    citations: [{ citation_id: `source-${id}#rules`, document_id: `source-${id}`, location: 'rules' }],
    ...overrides
  };
}

function ruleEvaluation(candidates, overrides = {}) {
  return {
    schema_version: 'product-match-rules.v1', status: 'evaluated', catalog_fingerprint: 'sha256:b2-fixture',
    profile_snapshot: { purpose: 'retirement', budget_amount: 20000, insured_person_id: 'mother', age: 58 },
    candidates, missing_fields: [], risk_flags: [], ...overrides
  };
}

function explain(candidates) {
  return async () => ({ workflow_run_id: 'b2-fixture-run', outputs: { match_result_json: JSON.stringify({
    status: 'ready', provider: 'fixture-explainer', candidates: candidates
      .filter(item => item.status !== 'not_matched')
      .map(item => ({ candidate_id: item.candidate_id, explanation: `${item.candidate_id}仅供销售核对，不替客户决定。`,
        citation_ids: item.citations.map(source => source.citation_id), case_ids: [] }))
  }) } });
}

function recommendationFixture(t) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const ws = 'fixture';
  store.createCustomer(ws, { customer_id: 'customer', name: 'B2夹具客户' });
  store.addOpportunity(ws, 'customer', { opportunity_id: 'need', environment: 'simulation' });
  store.addMessage(ws, 'need', { message_id: 'm1', idempotency_key: 'm1', role: 'customer', text: '请比较候选。', status: 'received', source: 'simulation' });
  const item = candidate('A');
  const service = createRecommendationService({
    store,
    evaluate: context => ruleEvaluation([item], { profile_snapshot: { context_versions: context.context_versions } }),
    generate: async (context, rules) => ({
      schema_version: 'product-match.v1', status: 'ready', candidates: rules.candidates.map(value => ({ ...value, explanation: '仅供人工核对。', case_references: [] })),
      context_versions: context.context_versions, catalog_fingerprint: rules.catalog_fingerprint,
      profile_snapshot: rules.profile_snapshot, review_required: true, trace: { provider: 'fixture', workflow_run_id: 'fixture' }
    })
  });
  const context = () => buildContext(store, ws, 'need');
  const generate = () => service.generate(ws, 'need', {
    idempotency_key: 'generate', latest_message_id: context().latest_message_id,
    expected_revision: context().context_versions.opportunity_revision
  });
  return { store, ws, service, context, generate };
}

test('[D02] confirmed profile is filtered by rules and B2 remains human-reviewed', async () => {
  const items = [candidate('retirement')];
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation(items), runDify: explain(items) });
  assert.equal(result.status, 'ready');
  assert.equal(result.review_required, true);
  assert.equal(result.candidates[0].status, 'eligible_for_discussion');
  assert.match(result.candidates[0].explanation, /销售核对/);
});

test('[D04] a confirmed child-education profile only returns education candidates', async () => {
  const education = candidate('education', 'eligible_for_discussion', {
    product_id: 'practice-education-annuity',
    reasons: [{ code: 'purpose_education', message: '教育用途匹配，仍需核对领取时间和交费能力', citation_ids: ['source-education#rules'] }]
  });
  const result = await runProductMatch(matchContext({
    need_profile: { purpose: 'education', budget_amount: 20000, budget_currency: 'CNY', person_ids: ['daughter'] },
    confirmed_facts: [
      { field: 'age', value: 8, person_id: 'daughter', status: 'confirmed' },
      { field: 'funds_usage_years', value: 10, person_id: null, status: 'confirmed' }
    ]
  }), { evaluateCandidates: async () => ruleEvaluation([education], {
    profile_snapshot: { purpose: 'education', budget_amount: 20000, insured_person_id: 'daughter', age: 8 }
  }), runDify: explain([education]) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(item => item.product_id), ['practice-education-annuity']);
  assert.match(result.candidates[0].reasons[0].message, /领取时间.*交费能力/);
});

test('[D06] an age hard-rule exclusion cannot be restored by B2', async () => {
  const item = candidate('age-excluded', 'not_matched', { reasons: [{ code: 'age_out_of_range', message: '年龄超出规则范围', citation_ids: ['source-age-excluded#rules'] }] });
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation([item]) });
  assert.equal(result.status, 'not_matched');
  assert.equal(result.candidates[0].status, 'not_matched');
  assert.match(result.candidates[0].explanation, /年龄超出规则范围/);
});

test('[D07] conflicting goals remain separate opportunities', t => {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  store.createCustomer('fixture', { customer_id: 'customer', name: '多需求客户' });
  store.addOpportunity('fixture', 'customer', { opportunity_id: 'retirement', purpose: '养老', environment: 'simulation' });
  store.addOpportunity('fixture', 'customer', { opportunity_id: 'liquidity', purpose: '三年内用钱', environment: 'simulation' });
  const opportunities = store.getCustomer('fixture', 'customer').opportunities;
  assert.deepEqual(new Set(opportunities.map(item => item.purpose)), new Set(['养老', '三年内用钱']));
  assert.equal(opportunities.length, 2);
});

test('[D08] conflicting ages stop B2 and expose a confirmation action', async () => {
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation([], {
    status: 'human_required', missing_fields: ['confirm_insured_age:58|68'], risk_flags: ['conflicting_insured_age']
  }) });
  assert.equal(result.status, 'human_required');
  assert.ok(result.risk_flags.includes('conflicting_insured_age'));
  assert.ok(result.missing_fields.includes('confirm_insured_age:58|68'));
});

test('[D09] catalog and RAG version mismatch stops B2 with repair details', async () => {
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation([], {
    status: 'human_required', missing_fields: ['catalog:catalog-v2', 'rag:rag-v1', 'republish_matching_knowledge_version'],
    risk_flags: ['knowledge_version_mismatch']
  }) });
  assert.equal(result.status, 'human_required');
  assert.ok(result.risk_flags.includes('knowledge_version_mismatch'));
  assert.deepEqual(result.missing_fields, ['catalog:catalog-v2', 'rag:rag-v1', 'republish_matching_knowledge_version']);
});

test('[D10] all hard-rule exclusions return no candidate truthfully', async () => {
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation([]) });
  assert.equal(result.status, 'not_matched');
  assert.deepEqual(result.candidates, []);
});

test('[D11] missing preference keeps both candidates and never decides for the customer', async () => {
  const items = [candidate('A', 'needs_information', { missing_fields: ['liquidity_preference'] }), candidate('B', 'needs_information', { missing_fields: ['liquidity_preference'] })];
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation(items, { missing_fields: ['liquidity_preference'] }), runDify: explain(items) });
  assert.equal(result.status, 'needs_information');
  assert.deepEqual(result.candidates.map(item => item.candidate_id), ['A', 'B']);
});

test('[D12] a human rejection records the reason and never binds the paused product', async t => {
  const f = recommendationFixture(t); const recommendation = await f.generate();
  const rejected = f.service.decide(f.ws, recommendation.recommendation_id, 'reject', {
    expected_revision: recommendation.revision, idempotency_key: 'reject-paused', reviewer: '销售', reason: '产品已暂停销售'
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(f.context().product_scope.product_id, '');
  assert.match(rejected.reason, /暂停销售/);
});

test('[D13] historical cases stay references and cannot replace current rule results', async () => {
  const items = [candidate('current')];
  const result = await runProductMatch(matchContext(), {
    evaluateCandidates: async () => ruleEvaluation(items),
    retrieveCases: async () => ({ status: 'ready', cases: [{ case_id: 'history-1', outcome: 'success', similarities: ['养老'], differences: ['年龄不同'], reason: '只作经验参考', source_kind: 'approved_case' }] }),
    runDify: async () => ({ outputs: { match_result_json: JSON.stringify({ status: 'ready', candidates: [{ candidate_id: 'current', explanation: '当前规则允许讨论，历史案例只作参考。', citation_ids: ['source-current#rules'], case_ids: ['history-1'] }] }) } })
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate_id, 'current');
  assert.equal(result.candidates[0].case_references[0].differences[0], '年龄不同');
});

test('[D14] new matching information expires the recommendation and its draft', async t => {
  const f = recommendationFixture(t); const before = f.context();
  const draft = f.store.saveDraft(f.ws, 'need', before.latest_message_id, before.context_versions.opportunity_revision, {
    schema_version: 'sales-assist.v1', status: 'draft_ready', draft: '基于旧画像的草稿', context_versions: before.context_versions
  }, before);
  const recommendation = await f.generate();
  f.store.addMessage(f.ws, 'need', { idempotency_key: 'new-profile', role: 'customer', text: '预算和用钱时间变了。', status: 'received', source: 'simulation' });
  assert.equal(f.service.get(f.ws, recommendation.recommendation_id).stale, true);
  assert.equal(f.store.getDraft(f.ws, draft.draft_id).stale, true);
});

test('[D15] multiple eligible candidates are retained under the same profile boundary', async () => {
  const items = [candidate('A'), candidate('B')];
  const result = await runProductMatch(matchContext(), { evaluateCandidates: async () => ruleEvaluation(items), runDify: explain(items) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(item => item.candidate_id), ['A', 'B']);
  assert.ok(result.candidates.every(item => item.explanation.includes('不替客户决定')));
});
