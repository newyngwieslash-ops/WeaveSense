import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, watch } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { QA_ROOT } from './b03-postgres-build.mjs';
import { seedSubtitleFixtures, CONCURRENT_BODY } from './c02-fixtures.mjs';
import { startSubtitleInput } from './c02-worker-fixture.mjs';

if(process.env.C02_QA_PRELOAD==='true' && /[\\/]vite[\\/]bin[\\/]vite\.js$/.test(process.argv[1]??'')) {
  assert.equal(process.env.LOOM_RUNTIME_MODE,'test');
  for(const key of ['AUTO_ANALYZE','EXTRACT_AUTO','AGENT_WORKER_ENABLED','AGENT_ASYNC_RESEARCH_ENABLED','AGENT_OPENCODE_WORKER_ENABLED','AGENT_ASSISTANT_ENABLED','AGENT_ASSISTANT_ACTIONS_ENABLED']) assert.equal(process.env[key],'false');
  const dsn=new URL(process.env.DATABASE_URL);assert.equal(dsn.hostname,'127.0.0.1');assert.match(dsn.pathname,/^\/b03_(dev|built)$/);assert.equal(dsn.password,'review-only-local');
  const directory=resolve(process.env.C02_QA_CONTROL_DIR);assert.ok(directory.startsWith(resolve(QA_ROOT)+sep));mkdirSync(directory,{recursive:true});
  const {Client}=await import('pg');const sql=new Client({connectionString:dsn.href});await sql.connect();await seedSubtitleFixtures(sql);
  const input=await startSubtitleInput({token:process.env.SUBTITLE_SERVICE_TOKEN,
    beforeReply:async fixture=>{if(fixture.kind==='conflict')await sql.query('update items set body=$2 where id=$1',[fixture.id,CONCURRENT_BODY]);},
    onMetrics:metrics=>{writeFileSync(join(directory,'network.tmp'),JSON.stringify(metrics,null,2));renameSync(join(directory,'network.tmp'),join(directory,'network.json'));}});
  process.env.SUBTITLE_URL=input.origin;
  const consumed=new Set();let chain=Promise.resolve();
  const scan=()=>{for(const name of readdirSync(directory)){
    if(!/^request-[a-f0-9-]{36}\.json$/.test(name)||consumed.has(name))continue;consumed.add(name);
    chain=chain.then(async()=>{const id=name.slice(8,-5),ack={ok:false};try{
      const command=JSON.parse(readFileSync(join(directory,name)));assert.equal(command.id,id);
      if(command.op==='state')ack.result={rows:(await sql.query("select id,body,material_version,extra,pipeline_status from items where id like 'qa-c02-%' order by id")).rows,
        counts:(await sql.query(`select (select count(*)::int from analyses) as analyses,(select count(*)::int from extract_jobs) as extract_jobs,(select count(*)::int from ai_jobs) as ai_jobs,(select count(*)::int from ai_runs) as ai_runs`)).rows[0],metrics:input.metrics};
      else if(command.op==='subtitle-enabled'){assert.equal(typeof command.enabled,'boolean');process.env.SUBTITLE_ENABLED=String(command.enabled);ack.result={enabled:command.enabled};}
      else if(command.op==='change-digest'){input.changeDigest(command.video);ack.result={changed:true};}
      else throw new Error('unknown_fixture_control');ack.ok=true;
    }catch(error){ack.error=error.message;}
    const file=join(directory,'response-'+id);writeFileSync(file+'.tmp',JSON.stringify(ack));renameSync(file+'.tmp',file+'.json');});
  }};watch(directory,scan);scan();
  writeFileSync(join(directory,'preload-ready.json'),JSON.stringify({pid:process.pid,worker:input.origin,ready:true}));
}
