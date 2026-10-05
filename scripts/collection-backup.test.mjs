import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seal, unseal, validatePayload, sha256, newChild, retentionCandidates, assertStoppedWriters, privateDirectory, restrictPath, snapshotSqlite, sqliteSummary } from './collection-backup.mjs';

const payload = () => {
  const files = [Buffer.from('PGDMP-fixture'), Buffer.from('sqlite-fixture'), Buffer.from('session-fixture')];
  return { manifest: { version: 1, generation: 'fixture-001', createdAt: '2026-10-05T00:00:00.000Z',
    resources: { database: 'fixture', bucket: 'fixture-media' }, schema: ['0002_schema.sql'],
    files: files.map((b, i) => ({ name: `${i}.bin`, kind: ['postgres','sqlite','session'][i], bytes: b.length, sha256: sha256(b) })) }, files: files.map(b => b.toString('base64')) };
};
test('authenticated encryption refuses changed data, wrong key and truncation', () => {
  const key = randomBytes(32); const data = payload(); const encrypted = seal(data, key);
  assert.deepEqual(unseal(encrypted, key), data);
  assert.ok(!encrypted.includes(Buffer.from('session-fixture')));
  for (const bytes of [Buffer.from(encrypted), encrypted.subarray(0, 20)]) {
    bytes[bytes.length - 1] ^= 1;
    assert.throws(() => unseal(bytes, key), /backup_authentication_failed/);
  }
  assert.throws(() => unseal(encrypted, randomBytes(32)), /backup_authentication_failed/);
});
test('manifest fails closed for hash, schema, resource identity, traversal and credential-bearing extras', () => {
  const expected = { resources: payload().manifest.resources, schema: ['0002_schema.sql'] };
  validatePayload(payload(), expected);
  const mutations = [p => p.manifest.files[0].sha256 = '0'.repeat(64), p => p.manifest.schema = ['9999.sql'],
    p => p.manifest.files[0].name = '../escape', p => p.manifest.resources.database = 'other',
    p => p.manifest.password = 'do-not-leak', p => p.manifest.files[0].url = 'https://user:secret@example.org',
    p => p.manifest.files.push(p.manifest.files[0]), p => p.files[0] += 'invalid'];
  for (const mutate of mutations) { const p = payload(); mutate(p); assert.throws(() => validatePayload(p, expected), /backup_/); }
});
test('new-child boundary refuses existing targets, traversal and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-backup-test-'));
  mkdirSync(join(root, 'existing'));
  assert.throws(() => newChild(root, 'existing'), /restore_target_exists/);
  assert.throws(() => newChild(root, '../escape'), /backup_path/);
  assert.equal(newChild(root, 'fresh'), join(root, 'fresh'));
  assert.equal(existsSync(join(root, 'fresh')), false);
  const other = mkdtempSync(join(tmpdir(), 'loom-backup-other-'));
  symlinkSync(other, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => newChild(join(root, 'link'), 'fresh'), /backup_symlink/);
  writeFileSync(join(root, 'file'), 'x');
  assert.throws(() => newChild(join(root, 'file'), 'fresh'), /backup_path/);
});
test('all required roles and any extra labelled writer must be stopped with correct ownership', () => {
  const roles = ['app','scheduler','telethon','gateway'];
  const containers = roles.map(role => ({ Config: { Labels: { 'loom.backup.group': 'fixture', 'loom.backup.role': role } }, State: { Status: 'exited', Running: false, Paused: false, Restarting: false } }));
  assertStoppedWriters(containers, 'fixture');
  assert.throws(() => assertStoppedWriters(containers.slice(1), 'fixture'), /backup_writer_missing/);
  assert.throws(() => assertStoppedWriters(containers, 'wrong'), /resource_label_mismatch/);
  containers[0].State.Running = true;
  assert.throws(() => assertStoppedWriters(containers, 'fixture'), /backup_writers_active/);
});
test('retention only proposes authenticated owned generations; never deletes or touches foreign state', () => {
  const rows = Array.from({length:40}, (_, i) => ({ generation: `daily-${i}`, createdAt: new Date(Date.UTC(2026, 8, i + 1)).toISOString() }));
  const remove = retentionCandidates(rows);
  assert.ok(remove.length > 0);
  for (const row of rows.slice(-7)) assert.ok(!remove.includes(row.generation));
  assert.ok(remove.every(n => rows.some(row => row.generation === n)));
});
test('SQLite backup API includes committed WAL and preserves pending outbox, with actual platform permissions', async () => {
  const parent=mkdtempSync(join(tmpdir(),'loom-sqlite-backup-')); const root=privateDirectory(parent,'restricted');
  const db=new DatabaseSync(join(root,'source.sqlite'));
  try {
    db.exec("pragma journal_mode=WAL; create table outbox(id integer primary key, state text); insert into outbox values(1,'pending');");
    const before=sqliteSummary(db); await snapshotSqlite(join(root,'source.sqlite'),join(root,'copy.sqlite'));
    const copy=new DatabaseSync(join(root,'copy.sqlite'),{readOnly:true});
    try {assert.deepEqual(sqliteSummary(copy),before);assert.equal(copy.prepare('select state from outbox').get().state,'pending');} finally {copy.close();}
    assert.match(restrictPath(root),/NTFS|POSIX/);
  } finally {db.close();}
});
