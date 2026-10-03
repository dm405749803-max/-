import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createProductMatchService } from '../../server/product-match/index.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'product-match-'));
  let clock = new Date('2026-09-23T12:00:00.000Z');
  const now = () => new Date(clock);
  const store = openDatabase(join(directory, 'test.sqlite'), { now });
  const workspace = 'product_match_test';
  const people = [
    ['customer-1', 'person-1', 'opportunity-1', 'retirement', 50_000],
    ['customer-2', 'person-2', 'opportunity-2', 'retirement', 52_000],
    ['customer-3', 'person-3', 'opportunity-3', 'education', 20_000]
  ];
  for (const [customerId, personId, opportunityId, purpose, budget] of people) {
    store.createCustomer(workspace, { customer_id: customerId, name: `测试${customerId}` });
    store.addPerson(workspace, customerId, { person_id: personId, name: `测试${personId}`, relationship: 'self' });
    store.addOpportunity(workspace, customerId, {
      opportunity_id: opportunityId, person_ids: [personId], purpose,
      budget_amount: budget, budget_currency: 'CNY', environment: 'simulation'
    });
    store.addMessage(workspace, opportunityId, {
      message_id: `message-${opportunityId}`, idempotency_key: `message-${opportunityId}`,
      role: 'customer', text: '请根据已确认条件做产品匹配', status: 'received',
      source: 'manual', environment: 'simulation', occurred_at: clock.toISOString()
    });
  }
  store.addPerson(workspace, 'customer-1', { person_id: 'unlinked-person', name: '未关联人物', relationship: 'child' });
  const insertFact = (customerId, opportunityId, personId, field, value, factId) => {
    store._helpers.run(`INSERT INTO facts(workspace_id,fact_id,customer_id,person_id,opportunity_id,field,value,evidence_message_ids,source,status,recorded_at,revision,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`, workspace, factId, customerId, personId, opportunityId, field,
    JSON.stringify(value), '[]', 'human', 'confirmed', clock.toISOString(), `idem-${factId}`);
  };
  insertFact('customer-1', 'opportunity-1', 'person-1', 'age', 35, 'age-1');
  insertFact('customer-1', 'opportunity-1', 'unlinked-person', 'age', 71, 'age-unlinked');
  insertFact('customer-1', 'opportunity-1', null, 'funds_usage_years', 12, 'usage-1');
  insertFact('customer-1', 'opportunity-1', null, 'payment_years', 10, 'payment-1');
  insertFact('customer-2', 'opportunity-2', 'person-2', 'age', 34, 'age-2');
  insertFact('customer-2', 'opportunity-2', null, 'funds_usage_years', 11, 'usage-2');
  insertFact('customer-2', 'opportunity-2', null, 'payment_years', 10, 'payment-2');
  insertFact('customer-3', 'opportunity-3', 'person-3', 'age', 8, 'age-3');
  insertFact('customer-3', 'opportunity-3', null, 'funds_usage_years', 5, 'usage-3');
  insertFact('customer-3', 'opportunity-3', null, 'payment_years', 5, 'payment-3');
  const contextFor = opportunityId => {
    const context = buildContext(store, workspace, opportunityId, { asOf: clock.toISOString() });
    const opportunity = store._helpers.one('SELECT * FROM opportunities WHERE workspace_id=? AND opportunity_id=?', workspace, opportunityId);
    return {
      ...context,
      need_profile: {
        purpose: opportunity.purpose, budget_amount: opportunity.budget_amount,
        budget_currency: opportunity.budget_currency,
        person_ids: JSON.parse(opportunity.person_ids), provenance: 'opportunity_record'
      }
    };
  };
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { store, workspace, now, setClock: value => { clock = new Date(value); }, contextFor, close };
}

function simulationProduct(overrides = {}) {
  return {
    product_id: 'product-retirement', product_version: 'v1', name: '演练养老产品',
    environment: 'simulation', catalog_status: 'active', valid_from: '2026-09-01', valid_to: '2026-09-30',
    approval_status: 'approved', reviewer: '人工复核员', approval_source: '演练资料复核单',
    source_kind: 'simulation_fixture',
    source_refs: [{ source_id: 'fixture-terms-v1', title: '演练条款', version: 'v1', section: '投保范围与交费期' }],
    rules: {
      purpose_codes: ['retirement'], insured_age: { min: 18, max: 60 },
      annual_budget: { min: 10_000, max: 100_000, currency: 'CNY' },
      funds_usage_years: { min: 10, max: 30 }, payment_years: [5, 10, 20]
    },
    idempotency_key: 'put-product-v1', ...overrides
  };
}

test('product catalog enforces reviewed sources, revisions, dates, isolation and stable fingerprints', () => {
  const f = fixture();
  try {
    const disabled = createProductMatchService({ store: f.store, now: f.now });
    assert.throws(() => disabled.putProduct(f.workspace, simulationProduct()), error => error.code === 'SIMULATION_PRODUCTS_DISABLED');
    const service = createProductMatchService({ store: f.store, now: f.now, allowSimulationProducts: true });
    const created = service.putProduct(f.workspace, simulationProduct());
    assert.equal(created.product.revision, 1);
    assert.equal(service.putProduct(f.workspace, simulationProduct()).idempotent_replay, true);
    assert.throws(() => service.putProduct(f.workspace, simulationProduct({
      name: '改名不允许重放', idempotency_key: 'put-product-v1'
    })), error => error.code === 'IDEMPOTENCY_KEY_REUSE');

    const first = service.listProducts(f.workspace, { environment: 'simulation', as_of: '2026-09-23T08:00:00+08:00' });
    const nextDay = service.listProducts(f.workspace, { environment: 'simulation', as_of: '2026-09-24' });
    assert.equal(first.items.length, 1);
    assert.match(first.catalog_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(first.catalog_fingerprint, nextDay.catalog_fingerprint);
    const expired = service.listProducts(f.workspace, { environment: 'simulation', as_of: '2026-10-01' });
    assert.equal(expired.items.length, 0);
    assert.notEqual(expired.catalog_fingerprint, first.catalog_fingerprint);
    assert.deepEqual(service.listProducts('other_workspace', { environment: 'simulation', as_of: '2026-09-23' }).items, []);

    assert.throws(() => service.putProduct(f.workspace, simulationProduct({
      expected_revision: 99, idempotency_key: 'stale-product-update'
    })), error => error.code === 'REVISION_CONFLICT');
    const updated = service.putProduct(f.workspace, simulationProduct({
      expected_revision: 1, idempotency_key: 'valid-product-update', rules: { ...simulationProduct().rules, payment_years: [10, 20] }
    }));
    assert.equal(updated.product.revision, 2);
    assert.deepEqual(updated.product.rules.payment_years, [10, 20]);
    assert.throws(() => service.putProduct(f.workspace, simulationProduct({
      product_id: 'bad-product', idempotency_key: 'bad-rule', rules: { projected_return: 0.08 }
    })), error => error.code === 'INVALID_PRODUCT_RULES');
    assert.throws(() => service.putProduct(f.workspace, simulationProduct({
      product_id: 'bad-source', idempotency_key: 'bad-source', source_refs: [{ source_id: 'x', title: 'x', version: 'v1', section: 'x', projected_return: '8%' }]
    })), error => error.code === 'INVALID_SOURCE_REF');
    f.setClock('2026-09-30T16:30:00.000Z'); // 北京时间已是 2026-10-01
    const beijingNextDay = service.listProducts(f.workspace, { environment: 'simulation' });
    assert.equal(beijingNextDay.as_of, '2026-10-01');
    assert.equal(beijingNextDay.items.length, 0);
  } finally { f.close(); }
});

test('deterministic evaluation uses only scoped confirmed facts and never guesses missing profile', () => {
  const f = fixture();
  try {
    const service = createProductMatchService({ store: f.store, now: f.now, allowSimulationProducts: true });
    service.putProduct(f.workspace, simulationProduct());
    const context = f.contextFor('opportunity-1');
    const evaluated = service.evaluate(context);
    assert.equal(evaluated.status, 'evaluated');
    assert.equal(evaluated.candidates.length, 1);
    assert.equal(evaluated.candidates[0].status, 'eligible_for_discussion');
    assert.equal(evaluated.profile_snapshot.insured_age, 35);
    assert.equal(evaluated.profile_snapshot.insured_person_id, 'person-1');
    assert.equal(evaluated.profile_snapshot.case_features.insured_age_band, '30-39');
    assert.equal(evaluated.profile_snapshot.case_features.annual_budget_band, '50000-59999');
    assert.equal(evaluated.profile_snapshot.provenance.insured_age.fact_id, 'age-1');
    assert.ok(evaluated.candidates[0].reasons.every(reason => reason.citation_ids.includes('fixture-terms-v1#投保范围与交费期')));
    assert.deepEqual(evaluated.candidates[0].allowed_payment_years, [5, 10, 20]);

    const missing = service.evaluate({
      ...context,
      need_profile: { ...context.need_profile, budget_amount: null, person_ids: ['person-1', 'unlinked-person'] },
      confirmed_facts: context.confirmed_facts.filter(fact => fact.field !== 'funds_usage_years')
    });
    assert.equal(missing.candidates[0].status, 'needs_information');
    assert.ok(missing.candidates[0].missing_fields.includes('insured_person'));
    assert.ok(missing.candidates[0].missing_fields.includes('budget_amount'));
    assert.ok(missing.candidates[0].missing_fields.includes('funds_usage_years'));
    assert.equal(missing.profile_snapshot.insured_age, null);

    const outside = service.evaluate({
      ...context,
      need_profile: { ...context.need_profile, budget_amount: 5000 },
      confirmed_facts: context.confirmed_facts.map(fact => fact.field === 'age' && fact.person_id === 'person-1' ? { ...fact, value: 70 } : fact)
    });
    assert.equal(outside.candidates[0].status, 'not_matched');
    assert.ok(outside.candidates[0].reasons.some(reason => reason.code === 'insured_age_out_of_range'));
    assert.ok(outside.candidates[0].reasons.some(reason => reason.code === 'annual_budget_out_of_range'));

    f.store.patchOpportunity(f.workspace, 'opportunity-1', 1, { budget_amount: 60_000 });
    const stale = service.evaluate(context);
    assert.equal(stale.status, 'human_required');
    assert.deepEqual(stale.risk_flags, ['stale_context']);
  } finally { f.close(); }
});

test('case lifecycle freezes recommendation-time bands and retrieves only approved sufficiently similar cases', () => {
  const f = fixture();
  try {
    const service = createProductMatchService({ store: f.store, now: f.now, allowSimulationProducts: true });
    service.putProduct(f.workspace, simulationProduct());
    const sourceContext = f.contextFor('opportunity-1');
    const sourceEvaluation = service.evaluate(sourceContext);
    const candidate = sourceEvaluation.candidates[0];
    const caseInput = {
      case_id: 'case-1', source_opportunity_id: 'opportunity-1',
      source_snapshot: {
        decision: 'accepted', recommendation_id: 'recommendation-1', generated_at: '2026-09-23T11:00:00.000Z',
        catalog_fingerprint: sourceEvaluation.catalog_fingerprint, profile_snapshot: sourceEvaluation.profile_snapshot
      },
      product_id: candidate.product_id, product_version: candidate.product_version, environment: 'simulation',
      outcome: 'success', sharing_approved: true, reviewer: '人工案例复核员',
      approval_source: '业务结果复盘', source_kind: 'simulation_fixture',
      snapshot_at: '2026-09-23T11:30:00.000Z', idempotency_key: 'put-case-1'
    };
    const created = service.putCase(f.workspace, caseInput);
    assert.equal(created.case.case_features.insured_age_band, '30-39');
    assert.equal(created.case.case_features.annual_budget_band, '50000-59999');
    assert.equal(Object.hasOwn(created.case, 'source_customer_id'), false);
    assert.equal(Object.hasOwn(created.case, 'source_opportunity_id'), false);
    assert.equal(service.putCase(f.workspace, caseInput).idempotent_replay, true);
    const corrected = service.putCase(f.workspace, {
      ...caseInput, outcome: 'failure', expected_revision: 1, idempotency_key: 'correct-case-outcome'
    });
    assert.equal(corrected.case.revision, 2);
    assert.equal(corrected.case.outcome, 'failure');
    assert.throws(() => service.putCase(f.workspace, {
      ...caseInput, outcome: 'deferred', expected_revision: 1, idempotency_key: 'stale-case-update'
    }), error => error.code === 'REVISION_CONFLICT');
    assert.throws(() => service.putCase(f.workspace, {
      ...caseInput, idempotency_key: 'tampered-features',
      source_snapshot: { ...caseInput.source_snapshot, profile_snapshot: {
        ...caseInput.source_snapshot.profile_snapshot,
        case_features: { ...caseInput.source_snapshot.profile_snapshot.case_features, annual_budget_band: '0-9999' }
      } }
    }), error => error.code === 'CASE_FEATURES_MISMATCH');

    const own = service.retrieveCases(sourceContext, candidate);
    assert.equal(own.status, 'none');
    assert.equal(own.cases.length, 0);
    assert.equal(own.rejected[0].reason, 'same_opportunity_or_customer');

    service.putCase(f.workspace, {
      ...caseInput, case_id: 'case-unshared', outcome: 'surrendered', sharing_approved: false,
      source_snapshot: { ...caseInput.source_snapshot, recommendation_id: 'recommendation-unshared' },
      idempotency_key: 'put-case-unshared'
    });
    f.store.patchOpportunity(f.workspace, 'opportunity-1', 1, { budget_amount: 90_000 });
    assert.equal(service.listCases(f.workspace, { sharing_approved: 'true' })[0].case_features.annual_budget_band, '50000-59999');
    assert.equal(service.listCases(f.workspace, { sharing_approved: 'false' }).length, 1);
    assert.throws(() => service.listCases(f.workspace, { sharing_approved: 'yes' }), error => error.code === 'INVALID_BOOLEAN_FILTER');

    const targetContext = f.contextFor('opportunity-2');
    const targetCandidate = service.evaluate(targetContext).candidates[0];
    const retrieved = service.retrieveCases(targetContext, targetCandidate);
    assert.equal(retrieved.status, 'found');
    assert.equal(retrieved.cases.length, 1);
    assert.equal(retrieved.cases[0].outcome, 'failure');
    assert.ok(retrieved.cases[0].similarities.includes('需求用途相同'));
    assert.match(retrieved.cases[0].reason, /不代表.*概率/);
    assert.equal(Object.hasOwn(retrieved.cases[0], 'similarity_score'), false);

    const unrelatedContext = f.contextFor('opportunity-3');
    const unrelatedCandidate = { ...targetCandidate, status: 'needs_information' };
    const unrelated = service.retrieveCases(unrelatedContext, unrelatedCandidate);
    assert.equal(unrelated.status, 'none');
    assert.equal(unrelated.cases.length, 0);
    assert.equal(unrelated.rejected[0].reason, 'insufficient_similarity');
    assert.deepEqual(service.listCases('other_workspace'), []);
  } finally { f.close(); }
});

test('unapproved products and blocked opportunities never produce marketing matches or case references', () => {
  const f = fixture();
  try {
    const service = createProductMatchService({ store: f.store, now: f.now, allowSimulationProducts: true });
    service.putProduct(f.workspace, simulationProduct({
      approval_status: 'pending', reviewer: null, approval_source: null, source_refs: [], idempotency_key: 'pending-product'
    }));
    const noSource = service.evaluate(f.contextFor('opportunity-1'));
    assert.equal(noSource.status, 'needs_source');
    assert.equal(noSource.candidates.length, 0);
    f.store.patchOpportunity(f.workspace, 'opportunity-1', 1, { purchased: true });
    const blockedContext = f.contextFor('opportunity-1');
    const blocked = service.evaluate(blockedContext);
    assert.equal(blocked.status, 'human_required');
    assert.ok(blocked.risk_flags.includes('opportunity_already_purchased'));
    assert.equal(service.retrieveCases(blockedContext, { candidate_id: 'x', product_id: 'x', product_version: 'x', status: 'needs_information' }).status, 'human_required');
  } finally { f.close(); }
});
