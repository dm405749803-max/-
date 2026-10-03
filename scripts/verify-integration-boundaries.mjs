import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.INTEGRATION_BASE_URL || 'http://127.0.0.1:8830');
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.notEqual(base.port, '8788', 'Never write acceptance fixtures to the original service.');
assert.ok(!base.username && !base.password);
const customerId = 'integration-fixture-customer';
const opportunityId = 'integration-fixture-no-source';
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(`/api/v2${path}`, base), {
    method, headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000)
  });
  return { status: response.status, ...await response.json() };
}

const customer = await request(`/customers/${customerId}`);
assert.equal(customer.status, 200, 'Run seed-integration-demo.mjs first.');
assert.equal(customer.data.contact_preferences.fixture, true, 'Only the named synthetic fixture is allowed.');
if (!customer.data.opportunities.some(item => item.opportunity_id === opportunityId)) {
  const created = await request(`/customers/${customerId}/opportunities`, 'POST', {
    opportunity_id: opportunityId, person_id: 'integration-fixture-child',
    purpose: '资料缺失验收（错误版本）', environment: 'simulation',
    product_id: 'fixture-product', product_version: 'fixture-v2', budget_amount: null
  });
  assert.equal(created.status, 201);
}
let messages = await request(`/opportunities/${opportunityId}/messages`);
assert.equal(messages.status, 200);
if (!messages.data.length) {
  const added = await request(`/opportunities/${opportunityId}/messages`, 'POST', {
    message_id: 'integration-no-source-message', idempotency_key: 'integration-no-source-message',
    role: 'customer', text: '这份演练产品的交费期有哪些？',
    status: 'received', source: 'simulation', environment: 'simulation'
  });
  assert.equal(added.status, 201);
}
const context = await request(`/opportunities/${opportunityId}/context`);
assert.equal(context.status, 200);
assert.equal(context.data.environment, 'simulation');
assert.equal(context.data.product_scope.product_id, 'fixture-product');
assert.equal(context.data.product_scope.product_version, 'fixture-v2');
messages = await request(`/opportunities/${opportunityId}/messages`);
const result = await request(`/opportunities/${opportunityId}/drafts`, 'POST', {
  latest_message_id: context.data.latest_message_id,
  expected_revision: context.data.context_versions.opportunity_revision
});
assert.equal(result.status, 201);
assert.equal(result.data.status, 'needs_source');
assert.equal(result.data.draft, '');
assert.equal(result.data.trace.workflow_run_id, null, 'Wrong-version fixture must not call the model.');
const confirmation = await request(`/drafts/${result.data.draft_id}/confirm`, 'POST', {
  expected_revision: result.data.revision, final_text: '这段测试文字不能绕过资料阻断。',
  delivery_mode: 'simulation', idempotency_key: `blocked-confirm-${randomUUID()}`
});
assert.equal(confirmation.status, 409);
assert.equal(confirmation.error.code, 'DRAFT_NOT_READY');
assert.deepEqual((await request(`/opportunities/${opportunityId}/messages`)).data, messages.data);
console.log('PASS: wrong-version evidence blocked before Dify; non-ready draft confirmation returns 409 and inserts no sales message.');
