#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/database.mjs';

const value = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const inputPath = value('--input'); const databasePath = value('--database'); const workspace = value('--workspace') || 'migration-test';
if (!process.argv.includes('--confirm-test-copy') || !inputPath || !databasePath) {
  console.error('Migration is test-only. Usage: node scripts/migrate-json-test-copy.mjs --confirm-test-copy --input <explicit-copy.json> --database <new.sqlite> [--workspace migration-test]');
  process.exit(2);
}
const input = resolve(inputPath); const output = resolve(databasePath);
try { await access(input); } catch { console.error('Explicit JSON test copy does not exist or is not readable.'); process.exit(2); }
try {
  await access(output);
  console.error('Refusing to overwrite an existing database.'); process.exit(2);
} catch (error) {
  if (error.code !== 'ENOENT') { console.error('Cannot safely inspect migration destination.'); process.exit(2); }
}
const state = JSON.parse(await readFile(input, 'utf8'));
if (!Array.isArray(state.customers)) { console.error('Input does not contain a customers array.'); process.exit(2); }
const store = openDatabase(output);
let customerCount = 0; let opportunityCount = 0;
try {
  for (const [index, legacy] of state.customers.entries()) {
    const cid = `legacy-customer-${index + 1}`;
    store.createCustomer(workspace, { customer_id: cid, name: String(legacy.name || legacy.nickname || `演练客户 ${index + 1}`), contact_preferences: { migration_source: 'explicit_test_copy' } });
    customerCount += 1;
    store.addOpportunity(workspace, cid, { opportunity_id: `legacy-opportunity-${index + 1}`, purpose: legacy.profile?.purpose || null, stage: 'migrated_review_required', status: 'open', environment: 'simulation' });
    opportunityCount += 1;
  }
} finally { store.close(); }
console.log(JSON.stringify({ status: 'review_required', workspace, customers: customerCount, opportunities: opportunityCount, warning: '仅迁移显式测试副本，原 JSON 未修改；所有需求需人工复核。' }));
