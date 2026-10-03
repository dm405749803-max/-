import test from 'node:test';
import assert from 'node:assert/strict';
import { generalizedProductBundles } from '../../knowledge/generalized-products.mjs';
import { retrieveKnowledge, __test } from '../../knowledge/retrieve.mjs';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';
import { createProductMatchService } from '../../server/product-match/index.mjs';
import { runSalesAssist } from '../../ai/sales-assist.mjs';

const now = () => new Date('2026-09-23T12:00:00Z');
const bundles = generalizedProductBundles();
const requestFor = item => ({ query: '可以选几年交费？', environment: 'simulation',
  interaction_type: 'new_consultation', product_scope: { product_id: item.catalog.product_id, product_version: item.catalog.product_version } });

test('new product evidence is scoped to its version and never enters real/disabled/old-contract requests', async () => {
  for (const item of bundles) {
    const request = requestFor(item);
    const good = await retrieveKnowledge(request, { now, allowSimulationKnowledge: true });
    assert.ok(good.documents.length);
    assert.ok(good.documents.every(doc => doc.product_id === item.catalog.product_id));
    assert.ok(good.documents[0].text.includes(item.catalog.rules.payment_years.map(y => `${y}年交`).join('、')));
    for (const blocked of [{ ...request, environment: 'real' }, { ...request, environment: undefined },
      { ...request, product_scope: { ...request.product_scope, product_version: 'wrong' } },
      { ...request, interaction_type: 'contract_service' }]) {
      assert.equal((await retrieveKnowledge(blocked, { now, allowSimulationKnowledge: true })).documents.length, 0);
    }
    assert.equal((await retrieveKnowledge(request, { now })).documents.length, 0);
    const benefit = await retrieveKnowledge({ ...request, query: '领取金额、现金价值和IRR是多少？' }, { now, allowSimulationKnowledge: true });
    assert.ok(benefit.documents.some(doc => doc.location === '利益演示与收益口径'));
    assert.ok(benefit.documents.find(doc => doc.location === '利益演示与收益口径').text.includes(item.illustration.returns));
    const chunk = item.document.chunks[0];
    assert.equal(__test.approvedSimulationChunk(item.document, { ...chunk, text: '擅自更改交费期' }, true), false);
  }
});

test('an exact scoped short Chinese keyword is enough to retrieve its product paragraph', async () => {
  const item = bundles.find(bundle => bundle.catalog.product_id === 'practice-savings-endowment');
  const result = await retrieveKnowledge({ ...requestFor(item), query: '安心储备两全保险可以选哪些交费期？' }, {
    now,
    allowSimulationKnowledge: true
  });
  assert.equal(result.evidence_status, 'ready');
  assert.equal(result.documents[0].location, '投保范围与交费期');
});

test('five distinct profiles choose their own product and feed matching evidence to the sales workflow', async t => {
  const store = openDatabase(':memory:', { now }); t.after(() => store.close());
  const service = createProductMatchService({ store, now, allowSimulationProducts: true });
  for (const item of bundles) service.putProduct('demo', item.catalog);
  const scenarios = [
    { id: 'retirement', purpose: '养老', age: 38, payment: 10, years: 22, product: bundles[0] },
    { id: 'education', purpose: '教育', age: 6, payment: 5, years: 12, product: bundles[1] },
    { id: 'wealth', purpose: '财富保值', age: 40, payment: 5, years: 20, product: bundles[2] },
    { id: 'legacy', purpose: '财富传承', age: 45, payment: 10, years: 20, product: bundles[3] },
    { id: 'savings', purpose: '长期储蓄', age: 35, payment: 5, years: 15, product: bundles[4] }
  ];
  for (const s of scenarios) {
    store.createCustomer('demo', { customer_id: s.id, name: '演练客户' });
    store.addPerson('demo', s.id, { person_id: `${s.id}-person`, name: '演练被保险人', relationship: s.id === 'education' ? 'child' : 'self' });
    store.addOpportunity('demo', s.id, { opportunity_id: s.id, person_ids: [`${s.id}-person`], purpose: s.purpose,
      budget_amount: 20000, budget_currency: 'CNY', environment: 'simulation',
      product_id: s.product.catalog.product_id, product_version: s.product.catalog.product_version });
    store.addMessage('demo', s.id, { message_id: s.id, idempotency_key: s.id, role: 'customer', text: '这款产品可以选几年交费？',
      status: 'received', source: 'simulation', environment: 'simulation', occurred_at: now().toISOString() });
    const customer = store.getCustomer('demo', s.id);
    store.patchCustomer('demo', s.id, customer.revision, { fact_changes: [
      ['age', s.age, `${s.id}-person`], ['payment_years', s.payment, null], ['funds_usage_years', s.years, null]
    ].map(([field, value, person_id]) => ({ field, value, person_id, opportunity_id: s.id, status: 'confirmed', source: 'human',
      evidence_message_ids: [], idempotency_key: `${s.id}-${field}` })) });
    const context = buildContext(store, 'demo', s.id, { asOf: now().toISOString() });
    const evaluated = service.evaluate(context);
    const eligible = evaluated.candidates.filter(c => c.status === 'eligible_for_discussion');
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].product_id, s.product.catalog.product_id);
    assert.ok(evaluated.candidates.some(c => c.status === 'not_matched'));
    let evidence;
    const result = await runSalesAssist(context, { now, allowSimulationKnowledge: true, runDify: async ({ inputs }) => {
      evidence = JSON.parse(inputs.knowledge_json);
      return { workflow_run_id: 'explicit-mock-generalized-sales', outputs: { status: 'draft_ready',
        draft: `这款可以选择${s.product.catalog.rules.payment_years.map(y => `${y}年交`).join('、')}。`,
        citation_ids: [evidence[0].citation_id], next_question: null, next_action: 'sales_review', risk_flags: [], missing_evidence: [] } };
    } });
    assert.equal(result.status, 'draft_ready');
    assert.ok(evidence.every(doc => doc.product_id === s.product.catalog.product_id));
    assert.ok(result.citations.every(c => c.document_id === s.product.document.document_id));
  }
});
