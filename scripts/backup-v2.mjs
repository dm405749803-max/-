#!/usr/bin/env node
import { DatabaseSync, backup } from 'node:sqlite';
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const value = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sourcePath = value('--database');
const destinationPath = value('--output');
if (!sourcePath || !destinationPath) {
  console.error('Usage: node scripts/backup-v2.mjs --database <existing.sqlite> --output <new-backup.sqlite>');
  process.exit(2);
}
const source = resolve(sourcePath); const destination = resolve(destinationPath);
try { await access(source); } catch { console.error('Source database does not exist or is not readable.'); process.exit(2); }
try {
  await access(destination);
  console.error('Refusing to overwrite an existing backup.'); process.exit(2);
} catch (error) {
  if (error.code !== 'ENOENT') { console.error('Cannot safely inspect backup destination.'); process.exit(2); }
}
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  } finally { check.close(); }
  console.log(JSON.stringify({ status: 'ok', backup: destination }));
} finally { db.close(); }
