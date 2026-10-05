#!/usr/bin/env node
/** Offline acceptance: real PostgreSQL/MinIO; only fixture transports and dummy credentials. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import pg from 'pg';
import { offlineEnv } from './readiness-offline.mjs';
import { isMainModule } from './with-app-env.mjs';

export const PG_IMAGE = 'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
const MINIO_IMAGE = 'minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
export const unknownMetric = reason => ({ status: 'unknown', reason });
const metrics = ['expected','collected','missing','duplicates','delay_p50','delay_p95','retry_recovery_seconds','max_rss_bytes','max_queue_age_seconds','paid_calls'];
export function assertEvidence(report) {
  assert.ok(['offline','live'].includes(report.evidence_scope), 'evidence_scope required');
  for (const key of metrics) {
    assert.ok(Object.hasOwn(report,key), `${key} required`);
    const value=report[key];
    if (value?.status==='unknown') {
      assert.ok(typeof value.reason==='string' && value.reason.trim(), `${key}: unknown needs reason`);
    } else assert.ok(typeof value==='number' && Number.isFinite(value) && value>=0, `${key}: invalid measurement`);
  }
  for (const key of ['expected','collected','missing','duplicates']) assert.ok(Number.isSafeInteger(report[key]), `${key}: measured count required`);
  assert.ok(report.expected>0, 'empty reference set cannot establish completeness');
  assert.equal(report.missing,0,'missing reference IDs'); assert.equal(report.duplicates,0,'duplicate IDs');
  assert.ok(report.collected>=report.expected,'insufficient collected IDs');
  if (report.evidence_scope==='offline') assert.equal(report.paid_calls,0,'offline paid calls must be measured zero');
  if(typeof report.delay_p50==='number' && typeof report.delay_p95==='number') assert.ok(report.delay_p50<=report.delay_p95,'invalid quantiles');
}
export function assertReferenceSets(reference, rows) {
  const actual=new Map(Object.keys(reference).map(id=>[id,[]]));
  for(const row of rows) { assert.ok(actual.has(row.source_id),`unexpected source ${row.source_id}`); actual.get(row.source_id).push(row.external_id); }
  for(const [id, expected] of Object.entries(reference)) {
    assert.equal(new Set(expected).size,expected.length,`invalid reference ${id}`);
    assert.deepEqual(actual.get(id).sort(),[...expected].sort(),`reference mismatch ${id}`);
  }
}
export async function finishEvidence(report, resources, persist) {
  report.cleanup_errors=[];
  try {
    for(const [resource,close] of Object.entries(resources)) {
      try {await close();}
      catch(error) {report.cleanup_errors.push({resource,error:String(error?.stack??error)});report.ok=false;}
    }
  } finally {await persist();}
  return report.cleanup_errors.length ? 1 : 0;
}
export const quantile=(values,p)=>values.length ? [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)] : unknownMetric('no observed samples');
export function isolateEnvironment(overrides={}) {
  const safe=offlineEnv(process.env,overrides);
  for(const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,safe);
}
export function sourceIdentity() {
  const receipt=resolve('.superpowers/sdd/source-sha.txt');
  if(existsSync(receipt)) {
    const sha=readFileSync(receipt,'utf8').trim(); assert.match(sha,/^[0-9a-f]{40}$/);
    return {git_sha:sha,source_state:'archive-receipt'};
  }
  const git=args=>spawnSync('git',args,{encoding:'utf8',windowsHide:true});
  const root=git(['rev-parse','--show-toplevel']); assert.equal(root.status,0);
  assert.equal(resolve(root.stdout.trim()).toLowerCase(),resolve('.').toLowerCase(),'refuse parent repository SHA');
  const status=git(['status','--porcelain','--untracked-files=normal','--','.',':!validation/collection',':!.superpowers',':!docs/operations/collection-acceptance.md']);assert.equal(status.status,0);
  const sha=git(['rev-parse','HEAD']);assert.equal(sha.status,0);
  return {git_sha:sha.stdout.trim(),source_state:status.stdout.trim()?'dirty-development-only':'clean-commit'};
}
export function docker(args) {
  const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:50_000,env:offlineEnv(process.env)});
  assert.equal(result.status,0,`docker ${args[0]}: ${result.stderr?.slice(-500)}`);
  return result.stdout.trim();
}
export async function isolatedPostgres(label='reliability') {
  const name=`weave-t17-${label}-${process.pid}-${Date.now().toString(36)}`;
  const ownership=`weave.t17.owner=${name}`;
  const id=docker(['run','-d','--name',name,'--label',ownership,'--memory','512m','--cpus','2',
    '-e','POSTGRES_PASSWORD=t17-dummy-local','-e','POSTGRES_DB=t17','-p','127.0.0.1::5432',PG_IMAGE]);
  const inspect=JSON.parse(docker(['inspect',id]))[0];
  const port=Number(inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const url=`postgresql://postgres:t17-dummy-local@127.0.0.1:${port}/t17`;
  let client;
  const close=async()=>{try {await client?.end();} finally {const live=JSON.parse(docker(['inspect',id]))[0];assert.equal(live.Config.Labels['weave.t17.owner'],name);docker(['rm','-f','-v',id]);}};
  try {
    for(let n=0;n<60;n++) {
      const attempt=new pg.Client({connectionString:url,connectionTimeoutMillis:1000});
      try {await attempt.connect();client=attempt;break;} catch {await attempt.end().catch(()=>{});await new Promise(r=>setTimeout(r,250));}
    }
    assert.ok(client,'PostgreSQL startup timeout');
    await client.query('create table _migrations(name text primary key,applied_at timestamptz not null default now())');
    const files=readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort();
    for(const file of files) {
      await client.query('begin');
      try {await client.query(readFileSync(join('migrations',file),'utf8'));await client.query('insert into _migrations(name) values($1)',[file]);await client.query('commit');}
      catch(error){await client.query('rollback');throw error;}
    }
    return {client,url,close,identity:{name,id,image:inspect.Image,digest:PG_IMAGE,memory_budget_bytes:inspect.HostConfig.Memory,cpu_nanoseconds:inspect.HostConfig.NanoCpus,migrations:files},
      async memory(){
        const stat=docker(['exec',id,'sh','-c','cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.stat']).split(/\r?\n/);
        return {current_bytes:Number(stat[0]),peak_bytes:Number(stat[1]),stat:Object.fromEntries(stat.slice(2).map(line=>{const [key,value]=line.split(' ');return [key,Number(value)];})),
          events:Object.fromEntries(docker(['exec',id,'cat','/sys/fs/cgroup/memory.events']).split(/\r?\n/).map(line=>{const [key,value]=line.split(' ');return [key,Number(value)];})),
          scope:'PostgreSQL container cgroup v2, includes file cache; not native Node RSS',rss_70_percent_gate:unknownMetric('memory.current includes page cache; application runs natively without an enforced container budget')};
      }};
  } catch(error){await close();throw error;}
}

async function main() {
  assert.ok(process.argv.includes('--offline'),'only --offline is supported; live acceptance needs authorized references');
  isolateEnvironment();
  const start=Date.now(), id=`reliability-${start}`;
  const directory=resolve('validation/collection/2026-10-02',id);mkdirSync(directory,{recursive:true});
  const report={...Object.fromEntries(metrics.map(key=>[key,unknownMetric('run did not reach measurement')])),evidence_scope:'offline',...sourceIdentity(),
    started_at:new Date(start).toISOString(),ok:false,scenarios:[],
    runtime:{node:process.version,platform:process.platform,arch:process.arch,cpus:cpus().length,host_ram_bytes:totalmem()},
    pending:['live 72h / 7d authorized source reference sets','24h memory endurance','native Node has no enforced container memory budget','real Telegram image/audio quality']};
  let db,vite,services;
  let maxRss=process.memoryUsage().rss;const sample=setInterval(()=>{maxRss=Math.max(maxRss,process.memoryUsage().rss);},20);
  try {
    db=await isolatedPostgres(); report.postgres=db.identity;
    process.env.DATABASE_URL=db.url;
    services=await fakeServices(report);
    const {createServer}=await import('vite');
    vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve('src')}},server:{middlewareMode:true,watch:null}});
    const {getSql}=await vite.ssrLoadModule('/src/lib/db.ts');const sql=await getSql();
    const scheduler=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    await sql.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
    await sql.query("insert into keywords(id,phrase,enabled) values('t17-marker','disabled',false)");
    await reliabilityScenarios({db,sql,vite,scheduler,report,directory,services});
    report.max_rss_bytes=maxRss;report.postgres.cgroup_memory=await db.memory();
    assertEvidence(report);report.ok=true;
  } catch(error) {report.error=String(error?.stack??error);process.exitCode=1;}
  finally {
    clearInterval(sample);report.max_rss_bytes=Math.max(maxRss,process.memoryUsage().rss);
    const cleanupStatus=await finishEvidence(report,{vite:()=>vite?.close(),services:()=>services?.close(),postgres:()=>db?.close()},()=>{
      report.finished_at=new Date().toISOString();report.duration_seconds=(Date.now()-start)/1000;
      writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence_directory:directory},null,2));
    });
    process.exitCode=process.exitCode||cleanupStatus;
    // The application's singleton pg.Pool has no public close API; all owned resources are closed above.
    process.exit(process.exitCode??0);
  }
}

const item=id=>({external_id:String(id),title:`fixture ${id}`,body:'offline fixture',author:'fixture',url:`https://t.me/fixture/${id}`,media_type:'text',media_urls:[],thumbnail_url:'',views:null,likes:null,published_at:null,extra:{}});
const batch=items=>({items,meta:{provider:'',attempts:['fixture'],paid_call:false}});
const publicResolver={async lookup(){return [{address:'93.184.216.34',family:4}];}};

async function fakeServices(report) {
  const name=`weave-t17-minio-${process.pid}-${Date.now().toString(36)}`;
  const id=docker(['run','-d','--name',name,'--label',`weave.t17.owner=${name}`,'--memory','512m','--cpus','2',
    '-e','MINIO_ROOT_USER=t17-dummy','-e','MINIO_ROOT_PASSWORD=t17-dummy-password','-p','127.0.0.1::9000',MINIO_IMAGE,'server','/data']);
  const inspected=JSON.parse(docker(['inspect',id]))[0];
  const endpoint=`http://127.0.0.1:${inspected.NetworkSettings.Ports['9000/tcp'][0].HostPort}`;
  const wire={mode:'ok',pageTwoFails:true,pages:[],modelCalls:0,httpCalls:0,historyTop:250,media:null};
  const server=httpServer(async(req,res)=>{
    wire.httpCalls++;
    const send=(body,status=200,headers={})=>{res.writeHead(status,headers);res.end(typeof body==='string'?body:JSON.stringify(body));};
    if(req.url==='/health')return send({ok:true,authorized:true,state:'ready',media_available:true});
    if(req.url==='/v1/history') {
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);wire.pages.push(body.min_id);
      if(wire.historyFails)return send({error:'temporary'},503);
      if(wire.historyDelay)await new Promise(r=>setTimeout(r,wire.historyDelay));
      if(body.min_id==='80'&&wire.pageTwoFails){wire.pageTwoFails=false;return send({error:'timeout'},503);}
      const ids=Array.from({length:wire.historyTop},(_,i)=>i+1).filter(i=>i>Number(body.min_id)).slice(0,80);
      return send({items:ids.map(item),last_id:String(ids.at(-1)??body.min_id),has_more:ids.length===80});
    }
    if(req.url==='/v1/media') {
      if(wire.mediaFails)return send({error:'temporary'},503);
      if(wire.mediaDelay)await new Promise(r=>setTimeout(r,wire.mediaDelay));
      return send(wire.media);
    }
    if(req.url==='/v1/reconcile')return send({day:'2026-10-04',attempted:0,succeeded:0,failed:0,succeeded_source_ids:[],budget_exhausted:false,
      outbox_source_ids:wire.gatewayStore.listReconciliationOutbox(),pending_details:0,completed_details:0});
    if(req.url==='/v1/reconcile/ack') {
      wire.ackCalls=(wire.ackCalls??0)+1;
      if(wire.ackFails)return send({error:'interrupted before ACK'},503);
      let raw='';for await(const chunk of req)raw+=chunk;
      return send({acked:wire.gatewayStore.ackReconciliationOutbox(JSON.parse(raw).source_ids)});
    }
    if(req.url==='/model'){wire.modelCalls++;return send({choices:[{message:{content:'offline OCR fixture'}}]});}
    if(req.url==='/image'){res.writeHead(200,{'content-type':'image/png'});return res.end(Buffer.from('89504e470d0a1a0a','hex'));}
    if(wire.mode==='503')return send('temporary',503);
    if(wire.mode==='429-body') {res.writeHead(429,{'retry-after':'3','content-length':'5000'});res.write('partial');return setTimeout(()=>res.destroy(),20);}
    if(wire.mode==='redirect')return send('',302,{location:'http://127.0.0.1/private'});
    if(wire.mode==='xml')return send('<rss><channel><item></rss>');
    const xml='<rss><channel><item><guid>001</guid><title>fixture</title></item></channel></rss>';
    if(wire.mode==='slow'){res.writeHead(200);res.write(xml.slice(0,10));return setTimeout(()=>res.end(xml.slice(10)),100);}
    return send(xml);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(target.href==='https://api.x.ai/v1/chat/completions') return originalFetch(`${origin}/model`,options);
    assert.ok([origin,endpoint].includes(target.origin),`blocked unapproved outbound origin ${target.origin}`);
    return originalFetch(input,options);
  };
  Object.assign(process.env,{MINIO_ENDPOINT:endpoint,MINIO_ACCESS_KEY:'t17-dummy',MINIO_SECRET_KEY:'t17-dummy-password',MINIO_BUCKET:'t17',
    TELEGRAM_WORKER_URL:origin,TELEGRAM_MEDIA_TOKEN:'t17-dummy-media',XAI_API_KEY:'t17-dummy-no-network'});
  report.minio={id,name,image:inspected.Image,digest:MINIO_IMAGE,memory_budget_bytes:inspected.HostConfig.Memory};
  for(let n=0;n<100;n++){if(await fetch(`${endpoint}/minio/health/live`).then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
  return {wire,origin,io:{resolver:publicResolver,transport:async(url,options)=>{
    assert.equal(url.hostname,'fixture.invalid','only fake public host may use loopback transport');
    const response=await fetch(`${origin}${url.pathname}`,{signal:options.signals?.abortSignal,redirect:'manual'});
    return {status:response.status,headers:Object.fromEntries(response.headers),body:response.body};
  }},async close(){
    globalThis.fetch=originalFetch;
    try {server.closeAllConnections();await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));}
    finally {const current=JSON.parse(docker(['inspect',id]))[0];assert.equal(current.Config.Labels['weave.t17.owner'],name);docker(['rm','-f','-v',id]);}
  }};
}

async function reliabilityScenarios({db,sql,vite,scheduler,report,directory,services}) {
  const {runSourceJob,tickDueSources,persistCollectedBatch}=scheduler;
  const {io,wire}=services;
  const addSource=async(id,platform='rss')=>sql.query(`insert into sources(id,platform,name,adapter,handle,feed_url,interval_minutes)
    values($1,$2,$1,$3,$4,$5,1)`,[id,platform,platform==='telegram'?'telegram_web':'rss',platform==='telegram'?'fixture':'',platform==='telegram'?'':'https://fixture.invalid/feed']);
  const due=async id=>sql.query("update sources set last_scanned_at=now()-interval '1 day',next_attempt_at=null where id=$1",[id]);
  await addSource('fault');
  for(const mode of ['503','429-body','xml','redirect','slow']) {
    wire.mode=mode;await due('fault');const begin=Date.now();const result=await tickDueSources(1,{},io);
    const [source]=await sql.query("select * from sources where id='fault'");
    if(mode==='slow'){assert.equal(result.errors,0);assert.ok(Date.now()-begin>=100);}
    else {assert.equal(result.errors,1,`${mode} must fail`);assert.equal(source.last_external_id,'');}
    if(mode==='429-body'){
      assert.equal(source.last_error_code,'rate_limited');assert.ok(new Date(source.next_attempt_at)>new Date());
      const before=wire.httpCalls;assert.ok((await runSourceJob('fault','manual',io)).error);assert.equal((await tickDueSources(1,{},io)).ran,0);assert.equal(wire.httpCalls,before);
    }
    report.scenarios.push({name:mode,error_code:source.last_error_code,elapsed_seconds:(Date.now()-begin)/1000});
  }
  wire.mode='ok';await sql.query("update sources set enabled=false where id='fault'");
  await addSource('pages','telegram');
  assert.equal((await tickDueSources(1,{},io)).items_new,80);
  await due('pages');assert.equal((await tickDueSources(1,{},io)).errors,1);
  assert.equal((await sql.query("select last_external_id from sources where id='pages'"))[0].last_external_id,'80');
  // A new native process loads the persisted cursor after the failed second page.
  const child=spawn(process.execPath,['scripts/collection-reliability-check.mjs','--resume-pages',new URL(db.url).port,new URL(services.origin).port],
    {env:offlineEnv(process.env),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let childOutput='';child.stdout.on('data',c=>{childOutput+=c;});child.stderr.on('data',c=>{childOutput+=c;});
  const childExit=await new Promise((done,reject)=>{child.on('error',reject);child.on('exit',done);});assert.equal(childExit,0,childOutput);
  const expectedPages=Array.from({length:250},(_,i)=>String(i+1));
  assertReferenceSets({pages:expectedPages},await sql.query("select source_id,external_id from items where source_id='pages'"));
  assert.deepEqual(wire.pages,['0','80','80','160','240']);
  wire.historyTop=330;await due('pages');assert.equal((await tickDueSources(1,{},io)).items_new,80);
  await due('pages');assert.equal((await tickDueSources(1,{},io)).items_new,0);
  assertReferenceSets({pages:Array.from({length:330},(_,i)=>String(i+1))},await sql.query("select source_id,external_id from items where source_id='pages'"));
  await sql.query("update sources set enabled=false where id='pages'");
  report.scenarios.push({name:'page2-503-process-restart-two-rounds-and-replay',reference_ids:Array.from({length:330},(_,i)=>String(i+1)),requested_cursors:wire.pages,restart_pid:child.pid,restart_exit:childExit});
  await lockScenarios({db,sql,vite,persistCollectedBatch,addSource,report});
  await migrationScenario({db,sql,report});
  await historyScenarios({db,sql,persistCollectedBatch,addSource,report,directory});
  await mediaScenarios({db,sql,vite,services,addSource,report,directory});
  await outboxScenario({db,sql,vite,services,report,directory});
  if(process.argv.includes('--quick')) report.pending.push('real wall-clock source recovery and 720/750-second capacity profiles omitted by --quick');
  else await timedScenarios({sql,vite,services,addSource,report,directory});
  const reference={pages:Array.from({length:330},(_,i)=>String(i+1)),fault:['001']};
  const rows=await sql.query("select source_id,external_id from items where source_id in ('pages','fault')");
  writeFileSync(join(directory,'reference.json'),JSON.stringify(reference,null,2));
  writeFileSync(join(directory,'collected.json'),JSON.stringify(rows,null,2));
  assertReferenceSets(reference,rows);
  report.reference_file='reference.json';report.collected_file='collected.json';
  report.expected=Object.values(reference).flat().length;report.collected=rows.length;report.missing=0;report.duplicates=0;
  report.delay_p50=unknownMetric('burst load checker measures due-to-job-start');report.delay_p95=unknownMetric('burst load checker measures due-to-job-start');
  report.retry_recovery_seconds=report.source_recovery?.eligibility_to_dispatch_seconds??unknownMetric('SQL time advanced for source recovery; --quick omits real minute cron wall time');
  report.max_queue_age_seconds=unknownMetric('load checker and cadence scenarios report their distinct queue scopes');
  report.paid_calls=0;report.fake_model_calls=wire.modelCalls;
}
async function lockScenarios({db,sql,vite,persistCollectedBatch,addSource,report}) {
  const {claimSource}=await vite.ssrLoadModule('/src/lib/server/scheduler-atomic.ts');
  const {enqueueItemMedia}=await vite.ssrLoadModule('/src/lib/server/media.ts');
  const a=new pg.Client({connectionString:db.url}),b=new pg.Client({connectionString:db.url});await a.connect();await b.connect();
  const qa={query:async(text,params)=>(await a.query(text,params)).rows};
  const qb={query:async(text,params)=>(await b.query(text,params)).rows};
  const pidA=(await a.query('select pg_backend_pid() pid')).rows[0].pid,pidB=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual(pidA,pidB);
  async function blocked() {
    const end=Date.now()+5000;
    while(Date.now()<end){const [row]=await sql.query('select $1::int=any(pg_blocking_pids($2)) blocked',[pidA,pidB]);if(row.blocked)return;await new Promise(r=>setTimeout(r,10));}
    throw new Error('deterministic overlap barrier not observed');
  }
  try {
    await addSource('race');await a.query('begin');assert.ok(await claimSource(qa,'race','a',true));
    const competing=claimSource(qb,'race','b',true);await blocked();await a.query('commit');assert.equal(await competing,null);
    await sql.query("update sources set claimed_at=now()-interval '16 minutes' where id='race'");
    const [source]=await sql.query("select * from sources where id='race'");
    await sql.query("insert into jobs(id,source_id,platform) values('a','race','rss')");
    let release,reached;const held=new Promise(r=>{release=r;});const barrier=new Promise(r=>{reached=r;});
    const pinned={transaction:async fn=>{
      await a.query('begin');
      try {const result=await fn({query:async(text,params)=>{const rows=await qa.query(text,params);if(/select claim_token,status.*for update/.test(text)){reached();await held;}return rows;}});await a.query('commit');return result;}
      catch(error){await a.query('rollback');throw error;}
    }};
    const commit=persistCollectedBatch(pinned,source,'a',batch([item('race-item')]));await barrier;
    const reclaim=claimSource(qb,'race','b',true);await blocked();release();assert.equal((await commit).items_new,1);assert.ok(await reclaim);
    await assert.rejects(()=>persistCollectedBatch(sql,source,'a',batch([item('stale-item')])),/scheduler_lease_lost/);
    assert.equal((await sql.query("select count(*)::int n from items where source_id='race'"))[0].n,1);
    const [freshSource]=await sql.query("select * from sources where id='race'");
    await sql.query("insert into jobs(id,source_id,platform) values('b','race','rss')");
    const faulted={transaction:fn=>sql.transaction(tx=>fn({query:async(text,params)=>{
      if(/update jobs set status/i.test(text))throw new Error('injected final job write failure');return tx.query(text,params);
    }}))};
    await assert.rejects(()=>persistCollectedBatch(faulted,freshSource,'b',batch([{...item('rolled-back'),media_urls:['https://fixture.invalid/rolled-back.jpg']}])),/injected final job write failure/);
    assert.equal((await sql.query("select count(*)::int n from items where source_id='race'"))[0].n,1);
    const [retained]=await sql.query("select claim_token,last_external_id from sources where id='race'");
    assert.equal(retained.claim_token,'b');assert.equal(retained.last_external_id,freshSource.last_external_id);
    const [{id:itemId}]=await sql.query("select id from items where source_id='race'");
    await a.query('begin');assert.equal(await enqueueItemMedia(itemId,['https://fixture.invalid/image'],'image',qa),1);
    const duplicate=enqueueItemMedia(itemId,['https://fixture.invalid/image'],'image',qb);await blocked();await a.query('commit');assert.equal(await duplicate,0);
    await sql.query("update sources set enabled=false where id='race'");
    report.scenarios.push({name:'independent-PG-locks',connection_pids:[pidA,pidB],barrier:'pg_blocking_pids observed A blocking B before release',claim_winners:1,batch_commit_before_reclaim:true,stale_fenced:true,media_uniqueness:true,final_job_write_failure_rolls_back_content_media_cursor_and_claim:true});
  } finally {await a.query('rollback');await a.end();await b.end();}
}

async function historyScenarios({db,sql,persistCollectedBatch,addSource,report,directory}) {
  report.history=[];
  for(const platform of ['rss','telegram','wechat']) {
    const id=`history-${platform}`;await addSource(id,platform);
    await sql.query(`insert into items(id,source_id,platform,external_id,title,url,normalized_wechat_url,pipeline_status)
      select $1||'-'||g,$1,$2,case when $2='telegram' then 'fixture/'||g when $2='wechat' then 'legacy-'||g else g::text end,'fixture '||g,
        case when $2='wechat' then 'https://mp.weixin.qq.com/s?__biz=MzFixture&mid='||g||'&idx=1' else '' end,
        case when $2='wechat' then 'https://mp.weixin.qq.com/s?__biz=MzFixture&idx=1&mid='||g else null end,'extracted'
        from generate_series(1,100000) g`,[id,platform]);
    // Use the production normalizer, including its actual parameter order.
    if(platform==='wechat') {
      const {normalizeWechatUrl}=await import('../src/lib/wechat-canonical.ts');
      const keys=Array.from({length:80},(_,i)=>normalizeWechatUrl(`https://mp.weixin.qq.com/s?__biz=MzFixture&mid=${i+1}&idx=1`));
      await sql.query("update items set normalized_wechat_url=x.key from unnest($2::text[]) with ordinality x(key,n) where source_id=$1 and external_id='legacy-'||x.n::text",[id,keys]);
    }
    await db.client.query('analyze items');
    const captured=[];const measure={transaction:fn=>sql.transaction(tx=>fn({query:async(text,params)=>{
      const start=performance.now();const rows=await tx.query(text,params);
      if(/select id, external_id, url, extra, normalized_wechat_url/.test(text)) captured.push({text,params,rows_returned:rows.length,rows:rows.map(({id,external_id,normalized_wechat_url})=>({id,external_id,normalized_wechat_url})),duration_ms:performance.now()-start});
      return rows;
    }}))};
    const inputs=Array.from({length:80},(_,i)=>({...item(platform==='wechat'?`incoming-${i+1}`:i+1),url:platform==='wechat'?`https://mp.weixin.qq.com/s?idx=1&mid=${i+1}&__biz=MzFixture`:item(i+1).url}));
    const token=`${id}-batch`;
    await sql.query("update sources set status='running',claim_token=$2 where id=$1",[id,token]);await sql.query('insert into jobs(id,source_id,platform) values($1,$2,$3)',[token,id,platform]);
    const [source]=await sql.query('select * from sources where id=$1',[id]);const rss=process.memoryUsage().rss,start=performance.now();
    assert.equal((await persistCollectedBatch(measure,source,token,batch(inputs))).items_new,0);
    const replayMs=performance.now()-start;
    assert.equal(captured.length,1);assert.equal(captured[0].rows_returned,80,'history lookup must return only the 80 referenced rows');
    const expectedInternalIds=Array.from({length:80},(_,i)=>`${id}-${i+1}`).sort();
    assert.deepEqual(captured[0].rows.map(row=>row.id).sort(),expectedInternalIds);
    assert.equal((await sql.query('select count(*)::int n from items where source_id=$1',[id]))[0].n,100000);
    let canonicalProof;
    if(platform==='wechat') {
      const incomingIds=inputs.map(row=>row.external_id);
      assert.ok(captured[0].rows.every(row=>!incomingIds.includes(row.external_id)),'canonical proof must not match a stored external ID');
      const retained=await sql.query('select id,external_id,normalized_wechat_url from items where source_id=$1 and normalized_wechat_url=any($2::text[])',[id,captured[0].params[2]]);
      assert.deepEqual(retained.map(row=>row.id).sort(),expectedInternalIds,'canonical matches must retain the intended internal IDs without duplicates');
      assert.equal((await sql.query('select count(*)::int n from items where source_id=$1 and external_id=any($2::text[])',[id,incomingIds]))[0].n,0);
      canonicalProof={incoming_external_ids:incomingIds,lookup_rows:captured[0].rows,retained_rows:retained,matching_branch:'canonical URL only; stored and incoming external IDs disjoint'};
      writeFileSync(join(directory,'history-wechat-identities.json'),JSON.stringify(canonicalProof,null,2));
    }
    const plan=(await db.client.query(`explain (analyze,buffers,format json) ${captured[0].text}`,captured[0].params)).rows[0]['QUERY PLAN'];
    const planPath=`history-${platform}-plan.json`;writeFileSync(join(directory,planPath),JSON.stringify(plan,null,2));
    assert.ok(JSON.stringify(plan).includes('Index'),'indexed history lookup required');
    const fresh=Array.from({length:80},(_,i)=>({...item(100001+i),url:platform==='wechat'?`https://mp.weixin.qq.com/s?idx=1&mid=${100001+i}&__biz=MzFixture`:item(100001+i).url}));
    const newToken=`${token}-new`;await sql.query("update sources set status='running',claim_token=$2 where id=$1",[id,newToken]);
    await sql.query('insert into jobs(id,source_id,platform) values($1,$2,$3)',[newToken,id,platform]);
    const [freshSource]=await sql.query('select * from sources where id=$1',[id]);
    const freshStart=performance.now();assert.equal((await persistCollectedBatch(measure,freshSource,newToken,batch(fresh))).items_new,80);
    assert.equal(captured[1].rows_returned,0,'80 new IDs must not return unrelated history');
    const newMs=performance.now()-freshStart;assert.equal((await sql.query('select count(*)::int n from items where source_id=$1',[id]))[0].n,100080);
    report.history.push({platform,...(canonicalProof?{identity_file:'history-wechat-identities.json',matching_branch:canonicalProof.matching_branch}:{}),history_rows:100000,batch_size:80,application_rows_returned:80,new_batch_rows_returned:0,new_batch_inserted:80,new_batch_duration_ms:newMs,lookup_duration_ms:captured[0].duration_ms,
      existing_batch_duration_ms:replayMs,rss_before_bytes:rss,rss_after_bytes:process.memoryUsage().rss,plan_file:planPath});
    await sql.query('update sources set enabled=false where id=$1',[id]);
  }
}

async function migrationScenario({db,sql,report}) {
  const [owner]=await sql.query("select id from items where source_id='race'");
  const migration=readFileSync('migrations/0024_media_identity.sql','utf8');
  for(const ambiguous of [false,true]) {
    await db.client.query('begin');
    try {
      await db.client.query('drop index media_item_source_url_idx; alter table items drop column normalized_wechat_url; drop index items_source_telegram_alias_idx');
      await db.client.query(`insert into media_objects(id,item_id,source_url,status) values
        ('migration-safe',$1,'https://fixture.invalid/migration',$2),('migration-duplicate',$1,'https://fixture.invalid/migration',$2)`,[owner.id,ambiguous?'stored':'remote']);
      if(ambiguous)await assert.rejects(()=>db.client.query(migration),/media_identity_conflict/);
      else {await db.client.query(migration);assert.equal((await db.client.query("select count(*)::int n from media_objects where source_url='https://fixture.invalid/migration'")).rows[0].n,1);}
    } finally {await db.client.query('rollback');}
    assert.equal((await sql.query("select count(*)::int n from media_objects where id like 'migration-%'"))[0].n,0);
  }
  report.scenarios.push({name:'0024-real-PG-append-only-safety',safe_duplicate_collapsed:true,ambiguous_stored_duplicate_refused:true,fixture_schema_changes_rolled_back:true});
}

async function mediaScenarios({db,sql,vite,services,addSource,report,directory}) {
  const storage=await vite.ssrLoadModule('/src/lib/server/storage.ts');assert.equal((await storage.ensureBucket()).ok,true);
  const media=await vite.ssrLoadModule('/src/lib/server/media.ts');const extract=await vite.ssrLoadModule('/src/lib/server/extract.ts');
  const nodes=await vite.ssrLoadModule('/src/lib/server/nodes.ts');const {prod}=await vite.ssrLoadModule('/src/lib/server/config.ts');
  await sql.query("delete from media_objects where item_id in(select id from items where source_id='race')");
  await addSource('media');await sql.query("update sources set enabled=false where id='media'");
  await sql.query("insert into items(id,source_id,platform,external_id,media_urls) values('media-item','media','rss','media-item','[\"https://fixture.invalid/image\"]')");
  await media.enqueueItemMedia('media-item',['https://fixture.invalid/image'],'image');
  const query=sql.query.bind(sql),transaction=sql.transaction.bind(sql);let fail=true;
  sql.transaction=fn=>transaction(tx=>fn({query:async(text,params)=>{
    if(fail&&text.startsWith('update items set media_urls'))throw new Error('injected metadata commit failure');
    return tx.query(text,params);
  }}));
  try {
    assert.deepEqual(await media.ingestPending(1,services.io),{stored:0,errors:1});
    const [after]=await query("select * from media_objects where item_id='media-item'");
    assert.equal(after.status,'error');assert.ok(after.object_key);assert.equal(after.content_type,'');
    assert.equal((await storage.getObject(after.object_key)).ok,true,'upload actually reached MinIO before DB rollback');
    assert.equal((await extract.extractItem('media-item',services.io)).ran,0);assert.equal(services.wire.modelCalls,0);
    fail=false;await query("update media_objects set next_attempt_at=now()-interval '1 second' where item_id='media-item'");
    assert.deepEqual(await media.ingestPending(1,services.io),{stored:1,errors:0});
    const [recovered]=await query("select * from media_objects where item_id='media-item'");assert.equal(recovered.object_key,after.object_key);
    assert.equal((await extract.extractItem('media-item',services.io)).ran,1);assert.equal((await extract.extractItem('media-item',services.io)).ran,0);
    assert.equal(services.wire.modelCalls,1);
    report.scenarios.push({name:'actual-MinIO-upload-DB-rollback-same-key-extraction',object_key:after.object_key,attempts:recovered.attempts,fake_model_calls:1});
  } finally {sql.transaction=transaction;}
  // Native SQL eligibility must skip dead/cooling first-four windows before LIMIT 1.
  for(const state of ['dead','cooling']) {
    await query(`insert into items(id,source_id,platform,external_id,collected_at) values($1,'media','rss',$1,now()+interval '1 day')`,[state]);
    for(let n=0;n<5;n++)await query(`insert into media_objects(id,item_id,source_url,object_key,status,content_type,next_attempt_at,created_at)
      values($1,$2,'https://fixture.invalid/'||$1,$1,$3,$4,$5::timestamptz,now()+($6::int*interval '1 second'))`,
      [`${state}-${n}`,state,n===4?'stored':state==='dead'?'dead':'error',n===4?'image/png':'',state==='cooling'?new Date(Date.now()+86400000).toISOString():null,n]);
  }
  await query("insert into items(id,source_id,platform,external_id,media_type,media_urls,collected_at) values('older-ready','media','rss','older-ready','image','[\"https://fixture.invalid/image\"]',now()-interval '1 day')");
  let selected;
  sql.query=async(text,params)=>{const rows=await query(text,params);if(text.startsWith('select i.id from items i where'))selected={text,params,rows};return rows;};
  assert.deepEqual(await extract.extractPending(1,services.io),{ran:1,errors:0});
  assert.deepEqual(selected.rows,[{id:'older-ready'}]);assert.equal(services.wire.modelCalls,2);
  const plan=(await db.client.query(`explain(analyze,buffers,format json) ${selected.text}`,selected.params)).rows[0]['QUERY PLAN'];
  writeFileSync(join(directory,'extraction-first4-plan.json'),JSON.stringify(plan,null,2));
  assert.deepEqual(await extract.extractPending(1,services.io),{ran:0,errors:0});sql.query=query;
  // A pinned transaction freezes PostgreSQL now(), establishing the exact inclusive lease boundary.
  await db.client.query('begin');sql.query=async(text,params)=>(await db.client.query(text,params)).rows;
  try {
    await sql.query("update items set pipeline_status='ingested' where id='older-ready'");
    await sql.query("update extract_jobs set status='running',attempts=1,started_at=now()-interval '15 minutes',claim_token='expired' where item_id='older-ready'");
    assert.deepEqual(await extract.extractPending(1,services.io),{ran:1,errors:0});
    assert.equal((await sql.query("select attempts from extract_jobs where item_id='older-ready'"))[0].attempts,2);
    await db.client.query('commit');
  } catch(error){await db.client.query('rollback');throw error;}finally {sql.query=query;}
  report.scenarios.push({name:'native-sha256-first4-limit1',history_rows:300000,dead_and_cooling_bypassed:true,fifth_not_expanded:true,plan_file:'extraction-first4-plan.json'});
  // Exercise the real production dispatcher with explicit stage clock; no direct ingest calls count as cron recovery.
  await query("update items set pipeline_status='extracted'");await query("delete from media_objects where item_id in ('dead','cooling')");
  await query("insert into items(id,source_id,platform,external_id) values('cadence','media','rss','cadence')");
  const bytes=Buffer.from('89504e470d0a1a0a','hex');assert.equal((await storage.putObject('telegram/fixture/999',bytes,'image/png')).ok,true);
  services.wire.media={object_key:'telegram/fixture/999',bytes:bytes.length,content_type:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')};
  await media.enqueueItemMedia('cadence',['telegram://fixture/999'],'image');
  const at=Math.floor(Date.now()/1800000)*1800000;let now=at;
  const beforeCalls=services.wire.modelCalls;
  prod.extractAuto=true;Object.assign(process.env,{AUTO_ANALYZE:'true',AUTO_ANALYZE_DAILY_LIMIT:'0',AI_ENGINE:'eino',AGENT_MODEL_NAME:'offline',AGENT_PRICE_INPUT_RMB_PER_MILLION:'2',AGENT_PRICE_OUTPUT_RMB_PER_MILLION:'4'});
  const snapshots=[];let retryAt;
  services.wire.mediaFails=true;
  for(const minute of [0,1,2,29,30]) {
    now=at+minute*60000;
    snapshots.push({minute,result:await nodes.runProductionTick({now:()=>now,deadlineMs:now+720000,allowExtract:true})});
    if(minute===0)retryAt=(await query("select next_attempt_at from media_objects where item_id='cadence'"))[0].next_attempt_at;
    services.wire.mediaFails=false;
  }
  assert.equal(snapshots[0].result.ingest_errors,1);assert.equal(snapshots[1].result.stored,0);assert.equal(snapshots[2].result.stored,0);assert.equal(snapshots[4].result.stored,1);
  const eligibility=(await query("select next_attempt_at from media_objects where item_id='cadence'"))[0];
  const windows=await query('select stage,count(*)::int windows from stage_windows group by stage order by stage');
  for(const stage of ['ingest','extract','analyze'])assert.equal(windows.find(r=>r.stage===stage)?.windows,2);
  report.scenarios.push({name:'production-dispatch-cadence',clock:'injected stage clock; actual database and dispatcher',snapshots,windows,fake_model_calls:services.wire.modelCalls-beforeCalls,
    media_retry_eligibility_seconds:(new Date(retryAt)-at)/1000,media_actual_dispatch_seconds:(now-at)/1000,eligibility_to_dispatch_seconds:(now-new Date(retryAt))/1000,proposed_two_minute_ticks:'NOT MET: preserved 30-minute ingest admission',final_next_attempt_at:eligibility.next_attempt_at});
  prod.extractAuto=false;process.env.AUTO_ANALYZE='false';
}
async function outboxScenario({db,sql,vite,services,report,directory}) {
  const {openStore}=await import('../workers/wechat-gateway/store.mjs');
  const filename=join(directory,'offline-gateway.sqlite');let store=openStore(filename);
  services.wire.gatewayStore=store;
  store.upsertSource({id:'outbox',name:'offline',account_id:'gh_offline',priority:'normal',sample_url:'https://mp.weixin.qq.com/s/offline',primary_feed_url:'https://fixture.invalid/feed'},'2026-10-01T00:00:00Z');
  store.recordPaidResult('outbox','ok',null,'normal','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z',true);
  const {prod}=await vite.ssrLoadModule('/src/lib/server/config.ts');prod.wechatGatewayUrl=services.origin;prod.wechatGatewayToken='offline-dummy';prod.cronSecret='offline-dummy';
  const {Route}=await vite.ssrLoadModule('/src/routes/api/cron/tick.ts');
  const handler=Route.options.server.handlers.POST;
  const originalNow=Date.now,query=sql.query.bind(sql);let now=Date.parse('2026-10-04T15:30:00Z');
  Date.now=()=>now;
  const tick=()=>handler({request:new Request('http://fixture.invalid/api/cron/tick',{method:'POST',headers:{authorization:'Bearer offline-dummy'}})});
  try {
    let failInsert=true;
    sql.query=(text,params)=>{if(failInsert&&text.includes('insert into reconciliation_queue'))throw new Error('injected PG enqueue failure');return query(text,params);};
    await tick();assert.equal(services.wire.ackCalls??0,0,'ACK cannot run before durable PG enqueue');assert.deepEqual(store.listReconciliationOutbox(),['outbox']);
    failInsert=false;services.wire.ackFails=true;now+=86400000;
    await tick();assert.equal(services.wire.ackCalls,1);assert.equal((await query("select count(*)::int n from reconciliation_queue where source_id='outbox'"))[0].n,1);
    store.close();store=openStore(filename);services.wire.gatewayStore=store;assert.deepEqual(store.listReconciliationOutbox(),['outbox']);
    services.wire.ackFails=false;now+=86400000;await tick();assert.equal(services.wire.ackCalls,2);assert.deepEqual(store.listReconciliationOutbox(),[]);
    assert.equal((await query("select count(*)::int n from reconciliation_queue where source_id='outbox'"))[0].n,1,'replayed delivery is idempotent');
    report.scenarios.push({name:'actual-cron-outbox-ACK',database:'real PG plus persistent SQLite gateway',precommit_ack_calls:0,interrupted_ack_calls:1,replayed_ack_calls:2,durable_queue_rows:1,clock:'three injected reconciliation day windows; no paid provider request'});
  } finally {Date.now=originalNow;sql.query=query;store.close();prod.wechatGatewayUrl='';prod.wechatGatewayToken='';}
}
async function resumePages() {
  const [pgPort,httpPort]=process.argv.slice(-2).map(Number);assert.ok([pgPort,httpPort].every(n=>Number.isSafeInteger(n)&&n>1024&&n<65536));
  isolateEnvironment({DATABASE_URL:`postgresql://postgres:t17-dummy-local@127.0.0.1:${pgPort}/t17`,TELEGRAM_WORKER_URL:`http://127.0.0.1:${httpPort}`});
  const nativeFetch=globalThis.fetch;globalThis.fetch=(url,init)=>{assert.equal(new URL(url).origin,process.env.TELEGRAM_WORKER_URL);return nativeFetch(url,init);};
  const {createServer}=await import('vite');const vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {const {getSql}=await vite.ssrLoadModule('/src/lib/db.ts');const sql=await getSql();const {tickDueSources}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    for(let n=0;n<3;n++){await sql.query("update sources set last_scanned_at=now()-interval '1 day',next_attempt_at=null where id='pages'");assert.equal((await tickDueSources(1)).errors,0);}
  } finally {await vite.close();}process.exit(0);
}

async function timedScenarios({sql,vite,services,addSource,report,directory}) {
  const {wire}=services;const {prod}=await vite.ssrLoadModule('/src/lib/server/config.ts');
  const {Route}=await vite.ssrLoadModule('/src/routes/api/cron/tick.ts');const handler=Route.options.server.handlers.POST;
  const {tickDueSources}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
  const media=await vite.ssrLoadModule('/src/lib/server/media.ts');const {runProductionTick}=await vite.ssrLoadModule('/src/lib/server/nodes.ts');
  const tick=()=>handler({request:new Request('http://fixture.invalid/api/cron/tick',{method:'POST',headers:{authorization:'Bearer offline-dummy'}})});
  await addSource('timed-retry','telegram');wire.historyFails=true;wire.historyTop=1;
  const failedAt=Date.now();const first=await(await tick()).json();assert.equal(first.collection.errors,1);wire.historyFails=false;
  const [{next_attempt_at}]=await sql.query("select next_attempt_at from sources where id='timed-retry'");
  const tickResults=[];
  for(let n=1;n<=2;n++) {
    await new Promise(r=>setTimeout(r,Math.max(0,failedAt+n*60000-Date.now())));
    tickResults.push({at:new Date().toISOString(),result:await(await tick()).json()});
  }
  const [job]=await sql.query("select started_at from jobs where source_id='timed-retry' and status='ok' order by started_at limit 1");assert.ok(job);
  const delay=(new Date(job.started_at)-new Date(next_attempt_at))/1000;assert.ok(delay>=0&&delay<=120,'recovery must start within two real minute ticks after eligibility');
  report.source_recovery={clock:'real wall time, actual cron POST handler',failure_at:new Date(failedAt).toISOString(),retry_at:next_attempt_at,started_at:job.started_at,eligibility_to_dispatch_seconds:delay,tickResults};
  await sql.query("update sources set enabled=false where id='timed-retry'");
  report.timed_capacity=[];
  for(const type of ['ordinary','telegram']) {
    await sql.query('delete from stage_windows');
    if(type==='telegram') {
      await sql.query("insert into items(id,source_id,platform,external_id) values('timed-media','media','telegram','timed-media')");
      await media.enqueueItemMedia('timed-media',['telegram://fixture/999'],'image');wire.mediaDelay=120000;
    }
    const plan=await media.mediaIngestPlan(sql,Date.now(),true);assert.equal(plan.reserveMs,type==='telegram'?195000:55000);
    for(let n=0;n<14;n++)await addSource(`capacity-${type}-${String(n).padStart(2,'0')}`,'telegram');
    wire.historyDelay=45000;const begin=Date.now();const deadline=begin+720000;
    console.error(`[T17] real ${type} serial profile started ${new Date(begin).toISOString()}; source fixture 45 seconds; media reserve ${plan.reserveMs/1000} seconds`);
    const collection=await tickDueSources(35,{deadlineMs:deadline-plan.reserveMs,reserveMs:100000,concurrency:1});
    const production=await runProductionTick({deadlineMs:deadline,allowExtract:false,allowTelegram:true});
    const elapsed=(Date.now()-begin)/1000;assert.ok(elapsed<720&&elapsed<750);assert.equal(collection.errors,0);assert.ok(collection.deferred>0);
    if(type==='telegram')assert.equal(production.stored,1);
    const prefix=`capacity-${type}-%`;
    const rows=await sql.query("select extract(epoch from(started_at-$2::timestamptz))::float delay from jobs where source_id like $1 order by started_at",[prefix,new Date(begin).toISOString()]);
    const result={type,source_count:14,concurrency:1,source_transport_delay_seconds:45,telegram_media_transport_delay_seconds:type==='telegram'?120:0,
      reservation_seconds:plan.reserveMs/1000,server_budget_seconds:720,loop_budget_seconds:750,elapsed_seconds:elapsed,collection,production,
      delay_p50:quantile(rows.map(r=>r.delay),.5),delay_p95:quantile(rows.map(r=>r.delay),.95),oldest_deferred_age_seconds:elapsed,
      proposed_due_wait_p95_120_seconds:quantile(rows.map(r=>r.delay),.95)<=120?'MET':'NOT MET',scope:'real wall-clock serial fixture; production default concurrency is 9, not a fleet capacity promise'};
    report.timed_capacity.push(result);writeFileSync(join(directory,`timed-${type}.json`),JSON.stringify(result,null,2));
    await sql.query('update sources set enabled=false where id like $1',[prefix]);
  }
  assert.ok(report.timed_capacity[1].collection.ran<report.timed_capacity[0].collection.ran,'195-second media reservation must reduce measured serial source capacity');
  wire.historyDelay=0;wire.mediaDelay=0;
}
if(isMainModule(import.meta.url)) {if(process.argv.includes('--resume-pages'))await resumePages();else await main();}
