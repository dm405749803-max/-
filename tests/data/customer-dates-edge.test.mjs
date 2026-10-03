import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/database.mjs';

function fixture(t) {
  const store = openDatabase(':memory:', { now: () => new Date('2026-09-23T10:00:00.000Z') });
  t.after(() => store.close());
  return store;
}

test('calendar boundaries handle minimum date, century leap years and today exactly', t => {
  const store = fixture(t);
  const minimum = store.createCustomer('demo', {
    customer_id: 'minimum', name: '最小日期', wechat_joined_on: '1900/1/1', wechat_joined_source: 'manual'
  });
  const leap = store.createCustomer('demo', {
    customer_id: 'leap', name: '世纪闰年', wechat_joined_on: '2000/2/29', wechat_joined_source: 'import'
  });
  const today = store.createCustomer('demo', {
    customer_id: 'today', name: '当天加入', wechat_joined_on: '2026-09-23', wechat_joined_source: 'platform'
  });
  assert.equal(minimum.wechat_joined_label, '1900/1/1');
  assert.equal(leap.wechat_joined_label, '2000/2/29');
  assert.equal(today.wechat_joined_label, '2026/9/23');
  for (const [customerId, date] of [['not-leap-1900', '1900/2/29'], ['not-leap-2100', '2100/2/29'], ['before-minimum', '1899/12/31'], ['after-today', '2026/9/24']]) {
    assert.throws(
      () => store.createCustomer('demo', { customer_id: customerId, name: customerId, wechat_joined_on: date, wechat_joined_source: 'manual' }),
      error => ['INVALID_WECHAT_JOINED_DATE', 'WECHAT_JOINED_DATE_OUT_OF_RANGE'].includes(error.code),
      date
    );
  }
});

test('exact-date filtering returns every same-day customer without tenant leakage', t => {
  const store = fixture(t);
  for (const customerId of ['same-a', 'same-b', 'same-c']) store.createCustomer('workspace-a', {
    customer_id: customerId, name: customerId, wechat_joined_on: '2026/9/3', wechat_joined_source: 'manual'
  });
  store.createCustomer('workspace-a', { customer_id: 'different-day', name: '不同日期', wechat_joined_on: '2026/9/4', wechat_joined_source: 'manual' });
  store.createCustomer('workspace-b', { customer_id: 'foreign-same-day', name: '另一租户', wechat_joined_on: '2026/9/3', wechat_joined_source: 'platform' });
  const sameDay = store.listCustomers('workspace-a', { joined_on: '2026-09-03' });
  assert.deepEqual(new Set(sameDay.map(customer => customer.customer_id)), new Set(['same-a', 'same-b', 'same-c']));
  assert.ok(sameDay.every(customer => customer.wechat_joined_label === '2026/9/3'));
  assert.equal(sameDay.some(customer => customer.customer_id === 'foreign-same-day'), false);
  for (const customer of sameDay) assert.equal(store.listCustomerDateAudit('workspace-a', customer.customer_id).length, 1);
});

test('platform-source corrections preserve provenance and no-op updates do not invent audits', t => {
  const store = fixture(t);
  let customer = store.createCustomer('demo', {
    customer_id: 'platform-date', name: '平台日期客户', wechat_joined_on: '2024/5/1',
    wechat_joined_source: 'import', wechat_joined_actor: 'initial-import'
  });
  customer = store.patchCustomer('demo', 'platform-date', customer.revision, {
    wechat_joined_on: '2024/5/2', wechat_joined_source: 'platform', wechat_joined_actor: 'platform-sync'
  });
  customer = store.patchCustomer('demo', 'platform-date', customer.revision, {
    wechat_joined_on: '2024-05-03', wechat_joined_actor: 'platform-correction'
  });
  const auditCount = store.listCustomerDateAudit('demo', 'platform-date').length;
  customer = store.patchCustomer('demo', 'platform-date', customer.revision, {
    wechat_joined_on: '2024/5/3', wechat_joined_source: 'platform', wechat_joined_actor: 'no-op-attempt'
  });
  assert.equal(customer.wechat_joined_on, '2024-05-03');
  assert.equal(customer.wechat_joined_source, 'platform');
  assert.equal(customer.wechat_joined_label, '2024/5/3');
  const audit = store.listCustomerDateAudit('demo', 'platform-date');
  assert.equal(audit.length, auditCount);
  assert.deepEqual(audit.map(row => [row.before_on, row.after_on, row.before_source, row.after_source, row.actor]), [
    [null, '2024-05-01', 'unknown', 'import', 'initial-import'],
    ['2024-05-01', '2024-05-02', 'import', 'platform', 'platform-sync'],
    ['2024-05-02', '2024-05-03', 'platform', 'platform', 'platform-correction']
  ]);
});

test('editing customer notes preserves join date, people, opportunities and historical facts', t => {
  const store = fixture(t);
  let customer = store.createCustomer('demo', {
    customer_id: 'c1', name: '客户甲', contact_preferences: { channel: 'wechat' },
    wechat_joined_on: '2026/9/23', wechat_joined_source: 'manual', wechat_joined_actor: 'sales-1'
  });
  store.addPerson('demo', 'c1', { person_id: 'p1', name: '女儿', relationship: 'daughter' });
  store.addOpportunity('demo', 'c1', { opportunity_id: 'o1', person_ids: ['p1'], purpose: 'education', environment: 'simulation' });
  const message = store.addMessage('demo', 'o1', { idempotency_key: 'fact-message', role: 'customer', text: '女儿今年8岁', status: 'received', source: 'manual' }).message;
  customer = store.getCustomer('demo', 'c1');
  customer = store.patchCustomer('demo', 'c1', customer.revision, { fact_changes: [{
    idempotency_key: 'daughter-age', field: 'daughter_age', value: 8, person_id: 'p1', opportunity_id: 'o1',
    evidence_message_ids: [message.message_id], source: 'message', status: 'confirmed'
  }] });
  const auditBefore = store.listCustomerDateAudit('demo', 'c1');
  const factBefore = customer.facts.find(fact => fact.field === 'daughter_age');
  customer = store.patchCustomer('demo', 'c1', customer.revision, {
    contact_preferences: { channel: 'wechat', note: '客户希望周末联系' }
  });
  assert.deepEqual(customer.contact_preferences, { channel: 'wechat', note: '客户希望周末联系' });
  assert.equal(customer.wechat_joined_on, '2026-09-23');
  assert.equal(customer.wechat_joined_source, 'manual');
  assert.equal(customer.wechat_joined_label, '2026/9/23');
  assert.equal(customer.persons[0].person_id, 'p1');
  assert.equal(customer.opportunities[0].opportunity_id, 'o1');
  assert.deepEqual(customer.facts.find(fact => fact.field === 'daughter_age'), factBefore);
  assert.deepEqual(store.listCustomerDateAudit('demo', 'c1'), auditBefore);
});

test('duplicate, invalid and stale date writes are atomic and leave no false audit', t => {
  const store = fixture(t);
  const customer = store.createCustomer('demo', {
    customer_id: 'atomic', name: '原客户', wechat_joined_on: '2026/9/20', wechat_joined_source: 'manual', wechat_joined_actor: 'sales-1'
  });
  assert.throws(() => store.createCustomer('demo', {
    customer_id: 'atomic', name: '重复客户', wechat_joined_on: '2026/9/21', wechat_joined_source: 'platform', wechat_joined_actor: 'platform'
  }), error => error.code === 'CUSTOMER_EXISTS');
  assert.throws(() => store.patchCustomer('demo', 'atomic', customer.revision, {
    wechat_joined_on: '2026/2/30', wechat_joined_source: 'manual', wechat_joined_actor: 'bad-date'
  }), error => error.code === 'INVALID_WECHAT_JOINED_DATE');
  const updated = store.patchCustomer('demo', 'atomic', customer.revision, {
    wechat_joined_on: '2026/9/21', wechat_joined_actor: 'sales-1'
  });
  assert.throws(() => store.patchCustomer('demo', 'atomic', customer.revision, {
    wechat_joined_on: '2026/9/22', wechat_joined_actor: 'stale-writer'
  }), error => error.code === 'REVISION_CONFLICT');
  const current = store.getCustomer('demo', 'atomic');
  assert.equal(current.name, '原客户');
  assert.equal(current.revision, updated.revision);
  assert.equal(current.wechat_joined_on, '2026-09-21');
  const audit = store.listCustomerDateAudit('demo', 'atomic');
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(row => row.actor), ['sales-1', 'sales-1']);
});
