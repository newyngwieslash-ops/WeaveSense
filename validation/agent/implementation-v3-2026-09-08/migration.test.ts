import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

test('V9 real legacy upgrade preserves null run_id results; failed migration rolls back and repeat is no-op',async()=>{
 const port=Number(process.env.REVIEW_PG_PORT);assert.ok(port>=1024);
 const schema='upgrade_'+randomUUID().replaceAll('-','');
 const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'review-only-local',database:'review'});await client.connect();
 try{
  await client.query(`create schema ${schema}`);await client.query(`set search_path to ${schema}`);
  await client.query(readFileSync('migrations/0002_schema.sql','utf8'));
  await client.query("insert into sources(id,platform,name) values('s','rss','legacy');insert into items(id,source_id,platform,external_id,title,body) values('i','s','rss','i','Old','Original');insert into analyses(id,item_id,summary) values('old-analysis','i','Preserved');insert into knowledge_notes(id,title,content,kind) values('old-note','Preserved','Original note','note')");
  await client.query("create table _migrations(name text primary key,applied_at timestamptz default now());insert into _migrations(name) values('0002_schema.sql')");
  await client.query("create function reject_migration() returns trigger language plpgsql as $$begin if new.name='0016_agent_terminal_states.sql' then raise exception 'injected migration failure';end if;return new;end$$;create trigger reject_migration before insert on _migrations for each row execute function reject_migration()");
  const env={...process.env,DATABASE_URL:`postgresql://postgres:review-only-local@127.0.0.1:${port}/review?options=${encodeURIComponent('-csearch_path='+schema)}`};
  const migrate=()=>promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{env,windowsHide:true});
  await assert.rejects(migrate(),/injected migration failure/);
  assert.equal((await client.query("select * from _migrations where name='0016_agent_terminal_states.sql'")).rowCount,0);
  assert.equal((await client.query("select * from pg_indexes where schemaname=$1 and indexname='ai_jobs_run_unique'",[schema])).rowCount,0);
  await client.query('drop trigger reject_migration on _migrations');
  const first=await migrate();assert.match(first.stdout,/applied 0016/);
  assert.equal((await client.query("select * from pg_indexes where schemaname=$1 and indexname='ai_jobs_run_unique'",[schema])).rowCount,1);
  const second=await migrate();assert.match(second.stdout,/up to date/);
  assert.deepEqual((await client.query('select id,summary,run_id from analyses')).rows,[{id:'old-analysis',summary:'Preserved',run_id:null}]);
  assert.deepEqual((await client.query('select id,content,run_id from knowledge_notes')).rows,[{id:'old-note',content:'Original note',run_id:null}]);
 }finally{await client.query(`drop schema ${schema} cascade`);await client.end();}
});
