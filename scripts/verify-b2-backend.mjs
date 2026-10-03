import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Opt-in real model smoke test. Creates synthetic records ONLY on the isolated B2 port.
const base = 'http://127.0.0.1:8832';
const workspace = 'b2-live-fixtures';
const suffix = randomUUID().slice(0, 8);
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-workspace-id': workspace },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150_000)
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result.error || result).slice(0, 1200)}`);
  return result.data ?? result;
}
const health = await request('/api/health');
assert.equal(health.backend_only, true);
assert.equal(health.backend_b2_enabled, true);
assert.equal(health.product_match_workflow_configured, true, 'Product-match Dify is not configured.');
assert.equal(health.memory_workflow_configured, true, 'Memory Dify is not configured.');

async function seedNeed(prefix, text) {
  const customerId = `${prefix}-customer-${suffix}`;
  const personId = `${prefix}-person-${suffix}`;
  const opportunityId = `${prefix}-need-${suffix}`;
  const customer = await request('/api/v2/customers', 'POST', {
    customer_id: customerId, name: '明确标记的后端演练客户',
    wechat_joined_on: '2026/9/23', wechat_joined_source: 'manual', wechat_joined_actor: '接口演练'
  }, 201);
  assert.equal(customer.wechat_joined_label, '2026/9/23');
  await request(`/api/v2/customers/${customerId}/persons`, 'POST', {person_id: personId, name: '演练本人', relationship: 'self'}, 201);
  await request(`/api/v2/customers/${customerId}/opportunities`, 'POST', {
    opportunity_id: opportunityId, person_ids: [personId], environment: 'simulation', purpose: '教育', budget_amount: 30000, budget_currency: 'CNY'
  }, 201);
  await request(`/api/v2/opportunities/${opportunityId}/messages`, 'POST', {
    idempotency_key: `${prefix}-message-${suffix}`, role: 'customer', status: 'received', source: 'simulation', text
  }, 201);
  return {customerId,personId,opportunityId};
}

const memory = await seedNeed('memory', '我本人今年38岁。');
const proposal = await request(`/api/v2/memory-review/opportunities/${memory.opportunityId}/proposals`, 'POST', {idempotency_key:`memory-proposal-${suffix}`}, 201);
assert.equal(proposal.status, 'pending');
assert.ok(proposal.facts.length > 0);
const before = await request(`/api/v2/opportunities/${memory.opportunityId}/context`);
assert.equal(before.confirmed_facts.length, 0);
const approved = await request(`/api/v2/memory-review/proposals/${proposal.proposal_id}/approve`, 'POST', {
  expected_revision:proposal.revision,idempotency_key:`memory-approve-${suffix}`,reviewer:'演练审核人'
});
assert.equal(approved.status, 'approved');
const after = await request(`/api/v2/opportunities/${memory.opportunityId}/context`);
assert.ok(after.confirmed_facts.length > 0);
console.log(JSON.stringify({step:'real-memory-api',status:'passed',proposal_id:proposal.proposal_id,workflow_run_id:proposal.trace?.workflow_run_id,confirmed_facts:after.confirmed_facts.length}));

const match = await seedNeed('match', '为教育安排资金，我本人38岁，每年预算30000元，至少10年后再用。这款产品可以选几年交费？');
const customer = await request(`/api/v2/customers/${match.customerId}`);
await request(`/api/v2/customers/${match.customerId}`, 'PATCH', {expected_revision:customer.revision,changes:{fact_changes:[
  {field:'age',value:38,person_id:match.personId}, {field:'funds_usage_years',value:10,person_id:null}, {field:'payment_years',value:3,person_id:null}
].map(item=>({...item,opportunity_id:match.opportunityId,status:'confirmed',source:'human',evidence_message_ids:[],idempotency_key:`${suffix}-${item.field}`}))}});
const catalog = await request('/api/v2/product-match/products?environment=simulation');
const existingProduct = catalog.items.find(item=>item.product_id==='fixture-product' && item.product_version==='fixture-v1');
await request('/api/v2/product-match/products','POST',{
  product_id:'fixture-product',product_version:'fixture-v1',name:'后端匹配规则演练样本',environment:'simulation',
  catalog_status:'active',valid_from:'2026-01-01',valid_to:'2027-12-31',approval_status:'approved',reviewer:'演练审核人',
  approval_source:'明确标记的合成规则，仅用于链路验收',source_kind:'simulation_fixture',
  source_refs:[{source_id:'b2-rules-fixture',title:'单产品匹配规则演练数据',version:'fixture-v1',section:'条件'}],
  rules:{purpose_codes:['education'],insured_age:{min:0,max:70},annual_budget:{min:1000,max:100000,currency:'CNY'},funds_usage_years:{min:5},payment_years:[3]},
  ...(existingProduct ? {expected_revision:existingProduct.revision} : {}),
  idempotency_key:`b2-verify-product-${suffix}`
},201);
let context = await request(`/api/v2/opportunities/${match.opportunityId}/context`);
const recommendation = await request(`/api/v2/product-match/opportunities/${match.opportunityId}/recommendations`,'POST',{
  expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id,idempotency_key:`match-generate-${suffix}`
},201);
assert.equal(recommendation.result.status,'ready',JSON.stringify(recommendation.result).slice(0,2000));
const candidate = recommendation.result.candidates.find(item=>item.status==='eligible_for_discussion');
assert.ok(candidate);
assert.deepEqual(candidate.allowed_payment_years,[3], 'Must agree with the existing A workflow fixture knowledge.');
assert.equal((await request(`/api/v2/opportunities/${match.opportunityId}/context`)).product_scope.product_id,'');
const accepted = await request(`/api/v2/product-match/recommendations/${recommendation.recommendation_id}/accept`,'POST',{
  expected_revision:recommendation.revision,idempotency_key:`match-accept-${suffix}`,reviewer:'演练销售',candidate_id:candidate.candidate_id,selected_payment_years:3
});
assert.equal(accepted.status,'accepted');
context = await request(`/api/v2/opportunities/${match.opportunityId}/context`);
assert.equal(context.product_scope.product_id,'fixture-product');
console.log(JSON.stringify({step:'real-product-match-api',status:'passed',recommendation_id:recommendation.recommendation_id,
  workflow_run_id:recommendation.result.trace?.workflow_run_id,provider:recommendation.result.trace?.provider,
  historical_case_count:candidate.case_references?.length || 0}));

const draft = await request(`/api/v2/opportunities/${match.opportunityId}/drafts`,'POST',{
  expected_revision:context.context_versions.opportunity_revision,latest_message_id:context.latest_message_id
},201);
assert.equal(draft.status,'draft_ready',JSON.stringify(draft).slice(0,2000));
assert.ok(draft.citations.length > 0);
console.log(JSON.stringify({step:'existing-sales-draft-api',status:'passed',draft_id:draft.draft_id,workflow_run_id:draft.trace?.workflow_run_id,citation_count:draft.citations.length,
  external_messages_sent:0}));

const outcome = await request(`/api/v2/product-match/recommendations/${recommendation.recommendation_id}/outcome`,'POST',{
  idempotency_key:`outcome-${suffix}`,outcome:'deferred',sharing_approved:true,reviewer:'演练审核人',
  approval_source:'合成案例的人工核验标记，不代表真实成交',snapshot_at:new Date().toISOString()
},201);
const dated = await request('/api/v2/customers?joined_on=2026-09-23');
assert.ok(dated.some(item=>item.customer_id===match.customerId));
console.log(JSON.stringify({step:'outcome-and-date-api',status:'passed',case_id:outcome.case_id || outcome.case?.case_id || null,date_label:'2026/9/23'}));
