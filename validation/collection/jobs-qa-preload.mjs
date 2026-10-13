import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pendingMigrations } from '../../scripts/migration-plan.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = [
  { id: 'qa-unknown', name: 'QA 覆盖未知', coverage: {}, label: '覆盖未知' },
  { id: 'qa-initial', name: 'QA 首次窗口', coverage: { complete: false, window_only: true, note: 'initial_window' }, label: '有限窗口' },
  { id: 'qa-overlap', name: 'QA 窗口重叠', coverage: { complete: false, window_only: true, note: 'window_overlap' }, label: '已到达上次边界' },
  { id: 'qa-gap', name: 'QA 窗口断档风险', coverage: { complete: false, window_only: true, note: 'window_gap' }, label: '窗口未衔接' },
  { id: 'qa-complete', name: 'QA 完整边界', coverage: { complete: true }, label: '已到达上次边界' },
];

export async function migratedDatabase() {
  const pg = new PGlite({ parsers: { 20: Number, 1082: v => v, 1186: v => v } });
  try {
    await pg.waitReady;
    await pg.exec('create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())');
    for (const { name } of pendingMigrations(readdirSync(new URL('../../migrations/', import.meta.url)), [])) {
      await pg.transaction(async tx => {
        await tx.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
        await tx.query('insert into _migrations(name) values ($1)', [name]);
      });
    }
    return pg;
  } catch (error) { await pg.close(); throw error; }
}

export async function seedJobs(pg) {
  const columns = (await pg.query("select column_name from information_schema.columns where table_name='jobs'")).rows;
  assert.ok(columns.some(row => row.column_name === 'coverage'), 'A04 migration coverage column is not ready');
  for (const [index, fixture] of FIXTURES.entries()) {
    await pg.query('insert into sources(id,platform,name,enabled,url) values($1,$2,$3,false,$4)',
      [fixture.id, 'rss', fixture.name, 'https://qa.invalid/' + fixture.id]);
    await pg.query(`insert into jobs(id,source_id,platform,started_at,finished_at,status,items_found,items_new,coverage)
      values($1,$2,'rss',$3,$3,'ok',$4,$5,$6::jsonb)`,
      [fixture.id, fixture.id, `2026-10-13T01:00:0${index}Z`, 60 + index, 10 + index, JSON.stringify(fixture.coverage)]);
  }
  await pg.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
  const rows = (await pg.query('select id,coverage from jobs order by id')).rows;
  assert.equal(rows.length, FIXTURES.length);
  for (const fixture of FIXTURES) assert.deepEqual(rows.find(row => row.id === fixture.id).coverage, fixture.coverage);
}

// Only the controlled server child opts into global injection; importing helpers is inert.
if (process.env.LOOM_JOBS_QA_PRELOAD === 'true' && /[\\/]vite[\\/]bin[\\/]vite\.js$/.test(process.argv[1] ?? '')) {
  assert.equal(process.env.LOOM_RUNTIME_MODE, 'test');
  assert.equal(String(process.env.DATABASE_URL ?? '').trim(), '');
  for (const key of ['AUTO_ANALYZE', 'EXTRACT_AUTO', 'AGENT_WORKER_ENABLED', 'AGENT_ASYNC_RESEARCH_ENABLED', 'AGENT_OPENCODE_WORKER_ENABLED', 'AGENT_ASSISTANT_ENABLED', 'AGENT_ASSISTANT_ACTIONS_ENABLED']) assert.equal(process.env[key], 'false');
  assert.equal(process.env.AI_ENGINE, 'legacy');
  assert.equal(globalThis.__pgliteInstance__, undefined, 'refusing to replace an existing database');
  const instance = migratedDatabase().then(async pg => { await seedJobs(pg); return pg; });
  globalThis.__pgliteInstance__ = instance;
  await instance;
}
