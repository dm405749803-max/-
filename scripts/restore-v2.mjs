#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

const value = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const backupPath = value('--backup');
const destinationPath = value('--output');
if (!backupPath || !destinationPath) {
  console.error('Usage: node scripts/restore-v2.mjs --backup <existing-backup.sqlite> --output <new-database.sqlite>');
  process.exit(2);
}
const source = resolve(backupPath); const destination = resolve(destinationPath);
try { await access(source); } catch { console.error('Backup does not exist or is not readable.'); process.exit(2); }
try {
  await access(destination);
  console.error('Refusing to overwrite an existing database.'); process.exit(2);
} catch (error) {
  if (error.code !== 'ENOENT') { console.error('Cannot safely inspect restore destination.'); process.exit(2); }
}
const check = new DatabaseSync(source, { readOnly: true });
try {
  const result = check.prepare('PRAGMA integrity_check').get();
  if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  const version = check.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
  if (!version) throw new Error('Not a sales-assist v2 backup.');
} finally { check.close(); }
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await copyFile(source, destination, constants.COPYFILE_EXCL);
console.log(JSON.stringify({ status: 'ok', restored: destination }));
