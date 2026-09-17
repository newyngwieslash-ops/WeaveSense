import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';

const root = resolve('artifacts/pglite-recovery');
const [phase, folder] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!phase) {
  mkdirSync(root, { recursive:true });
  const dir = mkdtempSync(join(root,'run-'));
  const processes = [];
  for (const step of ['snapshot','restore','reopen','verify-write']) {
    const result = spawnSync(process.execPath,[fileURLToPath(import.meta.url),step,dir],{
      encoding:'utf8',windowsHide:true,timeout:120000,
      env:{...process.env,DATABASE_URL:'',LOOM_MODEL_CONFIG:join(dir,'unused.local.json')},
    });
    assert.equal(result.status,0,result.stderr || result.error?.message);
    processes.push(JSON.parse(result.stdout));
  }
  assert.equal(new Set(processes.map(p=>p.pid)).size,4);
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,processes},null,2));
  console.log(JSON.stringify({ok:true,directory:dir,processes},null,2));
} else {
  assert.ok(resolve(folder).startsWith(root + (process.platform === 'win32' ? '\\' : '/')));
  assert.ok(['snapshot','restore','reopen','verify-write'].includes(phase));
  const archive = join(folder,'snapshot.tar');
  const manifestPath = join(folder,'manifest.json');
  let db;
  const summary = async () => {
    const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
    const result = {};
    for (const {tablename} of tables) {
      assert.match(tablename,/^[a-z_][a-z0-9_]*$/);
      const rows = (await db.query(`select row_to_json(t)::text as row from "${tablename}" t order by row_to_json(t)::text`)).rows.map(r=>r.row);
      result[tablename] = {count:rows.length,sha256:hash(JSON.stringify(rows))};
    }
    return result;
  };
  try {
    if (phase === 'snapshot') {
      db = new PGlite();
      await db.exec('create table _migrations(name text primary key)');
      for (const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()) {
        await db.exec(readFileSync(join('migrations',name),'utf8'));
        await db.query('insert into _migrations(name) values($1)',[name]);
      }
      await db.exec(readFileSync('validation/agent/search-followup-fixtures.sql','utf8'));
      await db.exec("insert into analyses(id,item_id,summary) values('recovery-analysis','qa-change','隔离摘要97%'); insert into knowledge_notes(id,title,content,item_ids) values('recovery-note','隔离简报','备份恢复证据','[\"qa-change\"]');");
      const tables = await summary();
      const dump = Buffer.from(await (await db.dumpDataDir()).arrayBuffer());
      writeFileSync(archive,dump,{flag:'wx'});
      writeFileSync(manifestPath,JSON.stringify({sha256:hash(dump),bytes:dump.length,tables},null,2),{flag:'wx'});
      // Export must leave the original process usable.
      assert.deepEqual(await summary(),tables);
    } else {
      const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
      const bytes = readFileSync(archive);
      assert.equal(hash(bytes),manifest.sha256,'Archive integrity mismatch');
      db = new PGlite({dataDir:join(folder,'restored'),...(phase === 'restore' ? {loadDataDir:new Blob([bytes])} : {})});
      if (phase === 'verify-write') {
        assert.equal((await db.query("select value from app_meta where key='recovery-write'")).rows[0].value,'survives-new-process');
        await db.query("delete from app_meta where key='recovery-write'");
      }
      assert.deepEqual(await summary(),manifest.tables);
      if (phase === 'reopen') await db.query("insert into app_meta(key,value) values('recovery-write','survives-new-process')");
    }
    await db.close(); db=undefined;
    console.log(JSON.stringify({phase,pid:process.pid,ok:true}));
  } finally { await db?.close(); }
}
