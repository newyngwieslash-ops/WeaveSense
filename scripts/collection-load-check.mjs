#!/usr/bin/env node
/** Real scheduler + isolated PostgreSQL. Accelerated burst, never a minute-tick or endurance claim. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { assertEvidence, assertReferenceSets, isolateEnvironment, isolatedPostgres, sourceIdentity, quantile, unknownMetric } from './collection-reliability-check.mjs';

isolateEnvironment();
const index=process.argv.indexOf('--sources');
const count=Number(index<0?100:process.argv[index+1]);
assert.ok(Number.isSafeInteger(count)&&count>0&&count<=5000,'invalid --sources');
const started=Date.now(),out=resolve('validation/collection/2026-10-02',`load-${count}-${started}`);
mkdirSync(out,{recursive:true});
const report={ok:false,evidence_scope:'offline',...sourceIdentity(),started_at:new Date(started).toISOString(),sources:count,
  expected:count*20,collected:unknownMetric('not measured'),missing:unknownMetric('not measured'),duplicates:unknownMetric('not measured'),
  delay_p50:unknownMetric('not measured'),delay_p95:unknownMetric('not measured'),retry_recovery_seconds:unknownMetric('no injected failures in capacity burst'),
  max_rss_bytes:0,max_queue_age_seconds:unknownMetric('not measured'),paid_calls:0,
  runtime:{node:process.version,platform:process.platform,arch:process.arch,logical_cpus:cpus().length,host_ram_bytes:totalmem()},
  note:'Accelerated due-set burst; SQL due-time aged explicitly. Delay is observed due-to-job-start, not real minute cron cadence.',
  pending:['live 72h / 7d','24h endurance','70% application container RSS: native Node has no enforced container budget']};
let db,vite,peak=process.memoryUsage().rss;
const sample=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},20);
try {
  db=await isolatedPostgres(`load-${count}`);report.postgres=db.identity;process.env.DATABASE_URL=db.url;
  const {createServer}=await import('vite');
  vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve('src')}},server:{middlewareMode:true,watch:null}});
  const {tickDueSources}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
  await db.client.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
  await db.client.query("insert into keywords(id,phrase,enabled) values('load-marker','disabled',false)");
  await db.client.query(`insert into sources(id,platform,name,adapter,feed_url,interval_minutes)
    select 'src-'||g,'rss','fixture '||g,'rss','https://fixture.invalid/s'||g||'/feed',10 from generate_series(0,$1::int-1) g`,[count]);
  let round=1,calls=0;
  const reference=rounds=>Object.fromEntries(Array.from({length:count},(_,source)=>[`src-${source}`,Array.from({length:rounds*10},(_,i)=>`s${source}-i${(Math.floor(i/10)+1)*100+i%10}`)]));
  writeFileSync(join(out,'reference.json'),JSON.stringify(reference(2)));
  const io={resolver:{async lookup(){return [{address:'93.184.216.34',family:4}];}},transport:async url=>{
    const match=/^\/s(\d+)\/feed$/.exec(url.pathname);assert.equal(url.hostname,'fixture.invalid');assert.ok(match,'unexpected public network request');
    calls++;if(calls%97===0)await new Promise(r=>setTimeout(r,120));
    const xml=`<rss><channel>${Array.from({length:10},(_,n)=>`<item><guid>s${match[1]}-i${round*100+n}</guid><title>fixture ${n}</title><description>offline</description></item>`).join('')}</channel></rss>`;
    return {status:200,headers:{'content-type':'application/rss+xml'},body:new Response(xml).body};
  }};
  const passes=[];
  for(const [label,value] of [['round1',1],['round2',2],['replay',2]]) {
    round=value;
    const {rows:[{due_at}]}=await db.client.query("select clock_timestamp() as due_at");
    await db.client.query("update sources set last_scanned_at=$1::timestamptz-interval '10 minutes' where id like 'src-%'",[due_at]);
    const pass={label,ticks:0,ran:0,items_new:0,errors:0,deferred:0};const begin=Date.now();
    for(let guard=0;guard<=Math.ceil(count/35);guard++) {
      const result=await tickDueSources(200,{},io);
      for(const key of ['ran','items_new','errors','deferred'])pass[key]+=result[key];pass.ticks++;
      assert.equal(result.errors,0,JSON.stringify(result.jobs.filter(j=>j.error)));
      if(result.ran===0)break;
    }
    assert.equal(pass.ran,count,'each source must run exactly once');assert.equal(pass.items_new,label==='replay'?0:count*10);
    const rows=(await db.client.query("select source_id,external_id from items where source_id like 'src-%'")).rows;
    assertReferenceSets(reference(value),rows);
    const delays=(await db.client.query("select extract(epoch from(started_at-$1::timestamptz))::float seconds from jobs where source_id like 'src-%' and started_at >= $1",[due_at])).rows.map(r=>r.seconds);
    assert.equal(delays.length,count);assert.ok(delays.every(n=>Number.isFinite(n)&&n>=0));
    Object.assign(pass,{elapsed_seconds:(Date.now()-begin)/1000,delay_p50:quantile(delays,.5),delay_p95:quantile(delays,.95),max_queue_age_seconds:Math.max(...delays),exact_reference_ids:rows.length});passes.push(pass);
  }
  report.passes=passes;report.collected=count*20;report.missing=0;report.duplicates=0;
  report.delay_p50=passes[0].delay_p50;report.delay_p95=passes[0].delay_p95;report.max_queue_age_seconds=Math.max(...passes.map(p=>p.max_queue_age_seconds));
  report.transport_calls=calls;assert.equal(calls,count*3);
  report.database_bytes=Number((await db.client.query('select pg_database_size(current_database()) bytes')).rows[0].bytes);
  report.postgres.cgroup_memory=await db.memory();
  report.max_rss_bytes=Math.max(peak,process.memoryUsage().rss);assertEvidence(report);report.ok=true;
} catch(error){report.error=String(error?.stack??error);process.exitCode=1;}
finally {
  clearInterval(sample);report.max_rss_bytes=Math.max(peak,process.memoryUsage().rss);
  await vite?.close();await db?.close();report.finished_at=new Date().toISOString();report.duration_seconds=(Date.now()-started)/1000;
  writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence_directory:out},null,2));process.exit(process.exitCode??0);
}
