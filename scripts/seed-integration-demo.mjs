import assert from 'node:assert/strict';

// This creates only a named synthetic fixture in the separate local integration service.
const base = new URL(process.env.INTEGRATION_BASE_URL || 'http://127.0.0.1:8830');
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Integration fixtures must stay on loopback.');
assert.notEqual(base.port, '8788', 'Do not seed the original running workbench.');
assert.ok(!base.username && !base.password);
const customerId = 'integration-fixture-customer';
const personId = 'integration-fixture-child';
const opportunityId = 'integration-fixture-education';
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json', 'x-workspace-id': 'demo' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}
const existing = await request(`/api/v2/customers/${customerId}`);
if (existing.status === 200) {
  console.log('Fixture already exists; existing records were not overwritten.');
} else {
  assert.equal(existing.status, 404, 'The integration API is not ready.');
  assert.equal((await request('/api/v2/customers', 'POST', {
    customer_id: customerId, name: '联调演练客户', contact_preferences: { fixture: true }
  })).status, 201);
  assert.equal((await request(`/api/v2/customers/${customerId}/persons`, 'POST', {
    person_id: personId, name: '演练女儿', relationship: 'daughter', age: 8, gender: '女'
  })).status, 201);
  assert.equal((await request(`/api/v2/customers/${customerId}/opportunities`, 'POST', {
    opportunity_id: opportunityId, person_id: personId, purpose: '交费方式核对（隔离验收）',
    budget_amount: 30000, budget_currency: 'CNY', environment: 'simulation',
    product_id: 'fixture-product', product_version: 'fixture-v1'
  })).status, 201);
  assert.equal((await request(`/api/v2/opportunities/${opportunityId}/messages`, 'POST', {
    message_id: 'integration-fixture-message-1', idempotency_key: 'integration-fixture-message-1',
    role: 'customer', text: '这份演练资料可以选几年交费？', status: 'received',
    source: 'simulation', environment: 'simulation', occurred_at: new Date().toISOString()
  })).status, 201);
  assert.equal((await request('/api/v2/tasks', 'POST', {
    task_id: 'integration-fixture-task', idempotency_key: 'integration-fixture-task',
    customer_id: customerId, opportunity_id: opportunityId, title: '核对演练资料来源',
    reason: '隔离验收：确认来源后再使用草稿', owner: '演练销售', status: 'open',
    due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  })).status, 201);
  console.log('Created isolated customer, person, opportunity, message and task fixtures. No real customer data or channel was used.');
}
