import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generalizedProductBundles } from '../knowledge/generalized-products.mjs';

// Real Dify calls with explicitly synthetic records; no channel sends.
const base = process.env.WORKBENCH_BASE_URL || 'http://127.0.0.1:8832';
const suffix = randomUUID().slice(0, 8);
async function request(path, method = 'GET', body, status = 200) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result.error));
  return result.data ?? result;
}
const health = await request('/api/health');
assert.ok(health.ok && health.backend_b2_enabled && health.product_match_workflow_configured);
const bundles = generalizedProductBundles();
for (const s of [
  { id: 'retirement', purpose: '养老', age: 38, years: 22, payment: 10, bundle: bundles[0] },
  { id: 'education', purpose: '教育', age: 6, years: 12, payment: 5, bundle: bundles[1] },
  { id: 'wealth', purpose: '财富保值', age: 40, years: 20, payment: 5, bundle: bundles[2] },
  { id: 'legacy', purpose: '财富传承', age: 45, years: 20, payment: 10, bundle: bundles[3] },
  { id: 'savings', purpose: '长期储蓄', age: 35, years: 15, payment: 5, bundle: bundles[4] }
]) {
  const id = `practice-${s.id}-${suffix}`;
  await request('/api/v2/customers', 'POST', { customer_id: id, name: `${s.purpose}方案演练客户`, wechat_joined_on: '2026/9/23', wechat_joined_source: 'manual' }, 201);
  await request(`/api/v2/customers/${id}/persons`, 'POST', { person_id: `${id}-person`, name: '方案演练对象', relationship: s.id === 'education' ? 'child' : 'self' }, 201);
  await request(`/api/v2/customers/${id}/opportunities`, 'POST', { opportunity_id: id, person_ids: [`${id}-person`], purpose: s.purpose,
    budget_amount: 20000, budget_currency: 'CNY', environment: 'simulation' }, 201);
  await request(`/api/v2/opportunities/${id}/messages`, 'POST', { idempotency_key: id, role: 'customer', status: 'received', source: 'simulation',
    text: `想安排${s.purpose}，被保险人${s.age}岁，每年预算2万元，${s.years}年后用。这款产品可以选几年交费？` }, 201);
  const customer = await request(`/api/v2/customers/${id}`);
  await request(`/api/v2/customers/${id}`, 'PATCH', { expected_revision: customer.revision, changes: { fact_changes: [
    ['age', s.age, `${id}-person`], ['payment_years', s.payment, null], ['funds_usage_years', s.years, null]
  ].map(([field, value, person_id]) => ({ field, value, person_id, opportunity_id: id, status: 'confirmed', source: 'human',
    evidence_message_ids: [], idempotency_key: `${id}-${field}` })) } });
  let context = await request(`/api/v2/opportunities/${id}/context`);
  const rec = await request(`/api/v2/product-match/opportunities/${id}/recommendations`, 'POST', {
    expected_revision: context.context_versions.opportunity_revision, latest_message_id: context.latest_message_id, idempotency_key: `match-${id}`
  }, 201);
  assert.equal(rec.result.status, 'ready', JSON.stringify(rec.result));
  const matches = rec.result.candidates.filter(c => c.status === 'eligible_for_discussion');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].product_id, s.bundle.catalog.product_id);
  await request(`/api/v2/product-match/recommendations/${rec.recommendation_id}/accept`, 'POST', { expected_revision: rec.revision,
    idempotency_key: `accept-${id}`, reviewer: '项目演练校验', candidate_id: matches[0].candidate_id, selected_payment_years: s.payment });
  context = await request(`/api/v2/opportunities/${id}/context`);
  const draft = await request(`/api/v2/opportunities/${id}/drafts`, 'POST', {
    expected_revision: context.context_versions.opportunity_revision, latest_message_id: context.latest_message_id
  }, 201);
  assert.equal(draft.status, 'draft_ready', JSON.stringify(draft));
  assert.ok(draft.citations.length && draft.citations.every(c => c.document_id === s.bundle.document.document_id));
  console.log(JSON.stringify({ product: s.bundle.catalog.name, recommendation_id: rec.recommendation_id,
    match_run: rec.result.trace?.workflow_run_id, draft_id: draft.draft_id, sales_run: draft.trace?.workflow_run_id,
    citation_count: draft.citations.length, draft: draft.content ?? draft.draft, external_messages_sent: 0 }));
}
