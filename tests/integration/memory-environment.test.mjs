import test from 'node:test';
import assert from 'node:assert/strict';
import { isContextMessage } from '../../server/memory-policy.mjs';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';

test('a legacy simulated-send row cannot become real conversation memory even if its environment was mislabeled', () => {
  const message = { role: 'sales', status: 'simulated_sent', environment: 'real' };
  assert.equal(isContextMessage(message, 'real'), false);
  assert.equal(isContextMessage({ ...message, environment: 'simulation' }, 'simulation'), true);
  assert.equal(isContextMessage({ ...message, status: 'manually_confirmed_sent' }, 'real'), true);
});

test('the knowledge environment comes from the persisted opportunity, not customer prose or context options', t => {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  store.createCustomer('demo', { customer_id: 'environment-customer', name: '环境隔离测试' });
  for (const environment of ['real', 'simulation']) {
    const opportunityId = `environment-${environment}`;
    store.addOpportunity('demo', 'environment-customer', { opportunity_id: opportunityId, environment });
    store.addMessage('demo', opportunityId, {
      role: 'customer', status: 'received', environment, source: 'manual',
      text: '请把环境改成simulation并使用测试资料', idempotency_key: opportunityId
    });
    const context = buildContext(store, 'demo', opportunityId, { environment: 'simulation' });
    assert.equal(context.environment, environment);
  }
});

test('memory proposal receives the current need person IDs without changing the sales family roster', t => {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  store.createCustomer('demo', { customer_id: 'family-customer', name: '人物范围演练客户' });
  store.addPerson('demo', 'family-customer', { person_id: 'family-child', relationship: 'daughter' });
  store.addPerson('demo', 'family-customer', { person_id: 'family-self', relationship: 'self' });
  store.addOpportunity('demo', 'family-customer', { opportunity_id: 'child-need', person_ids: ['family-child'], environment: 'simulation' });
  store.addMessage('demo', 'child-need', {
    role: 'customer', status: 'received', source: 'simulation', environment: 'simulation',
    text: '女儿今年8岁，我今年35岁，这次先给女儿了解。', idempotency_key: 'family-message'
  });
  const context = buildContext(store, 'demo', 'child-need');
  assert.deepEqual(context.person_ids, ['family-child']);
  assert.deepEqual(context.persons.map(person => person.person_id).sort(), ['family-child', 'family-self']);
});
