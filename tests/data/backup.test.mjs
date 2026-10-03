import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/database.mjs';

const exec = promisify(execFile);

test('backup and restore create verified new files without overwrite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-backup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.sqlite'); const backup = join(directory, 'backup.sqlite'); const restored = join(directory, 'restored.sqlite');
  const store = openDatabase(source); store.createCustomer('demo', { customer_id: 'c1', name: '可恢复客户' }); store.close();
  await exec(process.execPath, ['scripts/backup-v2.mjs', '--database', source, '--output', backup], { cwd: new URL('../..', import.meta.url) });
  await exec(process.execPath, ['scripts/restore-v2.mjs', '--backup', backup, '--output', restored], { cwd: new URL('../..', import.meta.url) });
  const recovered = openDatabase(restored);
  assert.equal(recovered.getCustomer('demo', 'c1').name, '可恢复客户'); recovered.close();
  await assert.rejects(exec(process.execPath, ['scripts/restore-v2.mjs', '--backup', backup, '--output', restored], { cwd: new URL('../..', import.meta.url) }));
});

test('legacy JSON migration requires an explicit test copy and new target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-migration-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'explicit-copy.json'); const output = join(directory, 'migrated.sqlite');
  await writeFile(input, JSON.stringify({ customers: [{ name: '副本客户', profile: { purpose: '教育' } }] }));
  await assert.rejects(exec(process.execPath, ['scripts/migrate-json-test-copy.mjs', '--input', input, '--database', output], { cwd: new URL('../..', import.meta.url) }));
  const result = await exec(process.execPath, ['scripts/migrate-json-test-copy.mjs', '--confirm-test-copy', '--input', input, '--database', output], { cwd: new URL('../..', import.meta.url) });
  assert.match(result.stdout, /review_required/);
  const migrated = openDatabase(output);
  assert.equal(migrated.getCustomer('migration-test', 'legacy-customer-1').name, '副本客户'); migrated.close();
});
