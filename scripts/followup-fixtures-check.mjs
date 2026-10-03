import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Always a fresh process-local database; never reads DATABASE_URL or model config.
const pg = new PGlite();
try {
  for (const name of ['0002_schema.sql', '0004_production.sql']) {
    await pg.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  const fixture = readFileSync(new URL('../validation/agent/search-followup-fixtures.sql', import.meta.url), 'utf8');
  await pg.exec(fixture);
  await pg.exec(fixture);
  assert.equal((await pg.query('select * from items')).rows.length, 8);
  const long = (await pg.query("select * from items where id='qa-long'")).rows[0];
  assert.ok(long.body.length > 24000 && long.external_id.length > 1000);
  assert.ok(long.body.endsWith('TAIL-973：返工率3%。'));
  assert.equal((await pg.query("select body from items where id='qa-empty'")).rows[0].body, '');
  assert.equal((await pg.query("select status from extract_jobs where id='qa-ocr'")).rows[0].status, 'pending');
  const boundary = await pg.query("select id from items where id in ('qa-before','qa-start','qa-last','qa-end') and published_at >= '2026-09-10T16:00:00Z' and published_at < '2026-09-11T16:00:00Z' order by id");
  assert.deepEqual(boundary.rows.map(r => r.id), ['qa-last', 'qa-start']);
  console.log('PASS: 8 isolated repeatable fixtures, long body/external_id/tail, empty, pending OCR, Shanghai half-open date boundary. No app or external calls.');
} finally { await pg.close(); }
