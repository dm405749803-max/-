import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';
import { buildContext } from '../../server/context.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-customer-date-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openDatabase(join(directory, 'dates.sqlite'), { now: () => new Date('2026-09-23T10:00:00.000Z') });
  t.after(() => { try { store.close(); } catch {} });
  return store;
}

test('create normalizes joined date and returns the compact unpadded label', async t => {
  const store = await fixture(t);
  const customer = store.createCustomer('demo', {
    customer_id: 'c1', name: '客户甲', wechat_joined_on: '2026/9/23', wechat_joined_source: 'manual', wechat_joined_actor: 'sales-1'
  });
  assert.equal(customer.wechat_joined_on, '2026-09-23');
  assert.equal(customer.wechat_joined_source, 'manual');
  assert.equal(customer.wechat_joined_label, '2026/9/23');
  const audit = store.listCustomerDateAudit('demo', 'c1');
  assert.equal(audit.length, 1);
  assert.deepEqual({ ...audit[0] }, {
    audit_id: audit[0].audit_id,
    customer_id: 'c1', before_on: null, after_on: '2026-09-23',
    before_source: 'unknown', after_source: 'manual', actor: 'sales-1', changed_at: '2026-09-23T10:00:00.000Z'
  });
});

test('unknown date stays null and never falls back to created_at', async t => {
  const store = await fixture(t);
  const customer = store.createCustomer('demo', { customer_id: 'unknown', name: '未知日期客户' });
  assert.equal(customer.wechat_joined_on, null);
  assert.equal(customer.wechat_joined_label, null);
  assert.equal(customer.wechat_joined_source, 'unknown');
  assert.deepEqual(store.listCustomerDateAudit('demo', 'unknown'), []);
  assert.notEqual(customer.updated_at, customer.wechat_joined_on);
});

test('supplement, correct, source-update and clear retain a truthful audit trail', async t => {
  const store = await fixture(t);
  let customer = store.createCustomer('demo', { customer_id: 'c1', name: '客户甲' });
  customer = store.patchCustomer('demo', 'c1', customer.revision, {
    wechat_joined_on: '2024/2/29', wechat_joined_source: 'import', wechat_joined_actor: 'operator-a'
  });
  assert.equal(customer.wechat_joined_on, '2024-02-29');
  assert.equal(customer.wechat_joined_label, '2024/2/29');
  customer = store.patchCustomer('demo', 'c1', customer.revision, {
    wechat_joined_on: '2024-03-01', wechat_joined_actor: 'operator-b'
  });
  assert.equal(customer.wechat_joined_source, 'import');
  customer = store.patchCustomer('demo', 'c1', customer.revision, {
    wechat_joined_source: 'platform', wechat_joined_actor: 'operator-c'
  });
  assert.equal(customer.wechat_joined_source, 'platform');
  customer = store.patchCustomer('demo', 'c1', customer.revision, {
    wechat_joined_on: null, wechat_joined_actor: 'operator-d'
  });
  assert.equal(customer.wechat_joined_on, null);
  assert.equal(customer.wechat_joined_label, null);
  assert.equal(customer.wechat_joined_source, 'unknown');
  const audit = store.listCustomerDateAudit('demo', 'c1');
  assert.deepEqual(audit.map(item => [item.before_on, item.after_on, item.before_source, item.after_source, item.actor]), [
    [null, '2024-02-29', 'unknown', 'import', 'operator-a'],
    ['2024-02-29', '2024-03-01', 'import', 'import', 'operator-b'],
    ['2024-03-01', '2024-03-01', 'import', 'platform', 'operator-c'],
    ['2024-03-01', null, 'platform', 'unknown', 'operator-d']
  ]);
});

test('calendar, range, source and provenance validation reject dirty values', async t => {
  const store = await fixture(t);
  const invalidDates = ['2023-02-29', '2026-02-30', '2026-13-01', '2026-9-23', '23/9/2026', '1899-12-31', '2026-09-24', '', 'not-a-date'];
  for (const [index, value] of invalidDates.entries()) {
    assert.throws(
      () => store.createCustomer('demo', { customer_id: `invalid-${index}`, name: '无效日期', wechat_joined_on: value, wechat_joined_source: 'manual' }),
      error => ['INVALID_WECHAT_JOINED_DATE', 'WECHAT_JOINED_DATE_OUT_OF_RANGE'].includes(error.code),
      value
    );
  }
  assert.throws(() => store.createCustomer('demo', { customer_id: 'missing-source', name: '缺来源', wechat_joined_on: '2026-09-23' }), error => error.code === 'WECHAT_JOINED_SOURCE_REQUIRED');
  assert.throws(() => store.createCustomer('demo', { customer_id: 'bad-source', name: '坏来源', wechat_joined_on: '2026-09-23', wechat_joined_source: 'guessed' }), error => error.code === 'INVALID_WECHAT_JOINED_SOURCE');
  assert.throws(() => store.createCustomer('demo', { customer_id: 'actor-only', name: '只给操作人', wechat_joined_actor: 'someone' }), error => error.code === 'WECHAT_JOINED_AUDIT_WITHOUT_CHANGE');
  assert.deepEqual(store.listCustomers('demo'), []);
});

test('list filters normalize exact and inclusive cross-year ranges using canonical SQL dates', async t => {
  const store = await fixture(t);
  const rows = [
    ['c0', null],
    ['c1', '2025/12/31'],
    ['c2', '2026/1/1'],
    ['c3', '2026/9/3'],
    ['c4', '2026/9/23']
  ];
  for (const [customerId, date] of rows) store.createCustomer('demo', {
    customer_id: customerId, name: customerId,
    ...(date ? { wechat_joined_on: date, wechat_joined_source: 'manual' } : {})
  });
  assert.deepEqual(store.listCustomers('demo', { joined_on: '2026/9/3' }).map(item => item.customer_id), ['c3']);
  assert.deepEqual(new Set(store.listCustomers('demo', { joined_from: '2025-12-31', joined_to: '2026/1/1' }).map(item => item.customer_id)), new Set(['c1', 'c2']));
  assert.deepEqual(new Set(store.listCustomers('demo', { joined_from: '2026/9/3', joined_to: '2026/9/23' }).map(item => item.customer_id)), new Set(['c3', 'c4']));
  assert.deepEqual(new Set(store.listCustomers('demo', { joined_to: '2026/1/1' }).map(item => item.customer_id)), new Set(['c1', 'c2']));
  assert.throws(() => store.listCustomers('demo', { joined_on: '2026/9/3', joined_from: '2026/1/1' }), error => error.code === 'JOINED_FILTER_CONFLICT');
  assert.throws(() => store.listCustomers('demo', { joined_from: '2026/9/23', joined_to: '2026/9/3' }), error => error.code === 'INVALID_JOINED_DATE_RANGE');
  assert.throws(() => store.listCustomers('demo', { joined_on: '2026-02-30' }), error => error.code === 'INVALID_WECHAT_JOINED_DATE');
});

test('date updates preserve optimistic locking and tenant isolation', async t => {
  const store = await fixture(t);
  let first = store.createCustomer('workspace-a', { customer_id: 'same-id', name: 'A' });
  store.createCustomer('workspace-b', { customer_id: 'same-id', name: 'B', wechat_joined_on: '2026/9/1', wechat_joined_source: 'platform' });
  first = store.patchCustomer('workspace-a', 'same-id', first.revision, { wechat_joined_on: '2026/9/23', wechat_joined_source: 'manual' });
  assert.throws(() => store.patchCustomer('workspace-a', 'same-id', 1, { wechat_joined_on: '2026/9/22' }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(store.getCustomer('workspace-a', 'same-id').wechat_joined_on, '2026-09-23');
  assert.equal(store.getCustomer('workspace-b', 'same-id').wechat_joined_on, '2026-09-01');
  assert.equal(store.listCustomerDateAudit('workspace-a', 'same-id').length, 1);
  assert.equal(store.listCustomerDateAudit('workspace-b', 'same-id').length, 1);
  assert.deepEqual(store.listCustomers('workspace-a', { joined_on: '2026/9/1' }), []);
});

test('legacy customer rows migrate to null date and unknown source without inferred history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-customer-date-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE customers (
      workspace_id TEXT NOT NULL, customer_id TEXT NOT NULL, name TEXT NOT NULL,
      contact_preferences TEXT NOT NULL DEFAULT '{}', marketing_opt_out INTEGER NOT NULL DEFAULT 0,
      human_handoff INTEGER NOT NULL DEFAULT 0, handoff_owner TEXT, revision INTEGER NOT NULL DEFAULT 1,
      profile_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, customer_id)
    );
    INSERT INTO customers VALUES ('demo','legacy','旧客户','{}',0,0,NULL,1,1,'2024-01-02T00:00:00.000Z','2026-09-23T00:00:00.000Z');
  `);
  legacy.close();
  const store = openDatabase(path, { now: () => new Date('2026-09-23T10:00:00.000Z') });
  t.after(() => { try { store.close(); } catch {} });
  const customer = store.getCustomer('demo', 'legacy');
  assert.equal(customer.wechat_joined_on, null);
  assert.equal(customer.wechat_joined_label, null);
  assert.equal(customer.wechat_joined_source, 'unknown');
  assert.deepEqual(store.listCustomerDateAudit('demo', 'legacy'), []);
  assert.ok(store.raw.prepare('PRAGMA table_info(customers)').all().some(column => column.name === 'wechat_joined_on'));
});

test('ContextEnvelope adds explicit opportunity-record need_profile without changing persons', async t => {
  const store = await fixture(t);
  store.createCustomer('demo', { customer_id: 'c1', name: '客户甲' });
  store.addPerson('demo', 'c1', { person_id: 'p1', name: '女儿', relationship: 'daughter' });
  store.addOpportunity('demo', 'c1', {
    opportunity_id: 'o1', purpose: 'education', budget_amount: 30000, budget_currency: 'CNY', person_ids: ['p1'], environment: 'simulation'
  });
  store.addMessage('demo', 'o1', { idempotency_key: 'm1', role: 'customer', text: '想看看教育安排', status: 'received', source: 'manual' });
  const context = buildContext(store, 'demo', 'o1');
  assert.deepEqual(context.need_profile, {
    purpose: 'education', budget_amount: 30000, budget_currency: 'CNY', person_ids: ['p1'], provenance: 'opportunity_record'
  });
  assert.deepEqual(context.person_ids, ['p1']);
  assert.equal(context.persons[0].person_id, 'p1');
  assert.deepEqual(context.confirmed_facts, []);
});
