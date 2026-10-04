import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('gateway verified primary observation survives paid cache Atom parser atomic health flow', async () => {
  const {openStore}=await import(new URL('../../../workers/wechat-gateway/store.mjs',import.meta.url).href);
  const {toAtom}=await import(new URL('../../../workers/wechat-gateway/atom.mjs',import.meta.url).href);
  const store=openStore(':memory:');
  const source={id:'primary-clock',name:'synthetic',account_id:'gh_synthetic',priority:'normal',sample_url:'https://mp.weixin.qq.com/s/synthetic',primary_feed_url:'https://feed.invalid/primary'};
  const initial='2026-10-01T00:00:00Z',completeAt='2026-10-03T12:00:00Z';
  const item={canonical_id:'wx:MzSynthetic:1:1',account_id:source.account_id,account_name:'synthetic',title:'synthetic',published_at:initial,
    original_url:'https://mp.weixin.qq.com/s?__biz=MzSynthetic&mid=1&idx=1',body_text:'summary',body_complete:false,cover_url:'',provider:'primary',discovered_at:initial};
  store.upsertSource(source,initial);store.upsertGatewayItems(source.id,[item],initial);
  const firstXml=toAtom(source.id,source.name,store.listGatewayItems(source.id,initial));
  store.upsertGatewayItems(source.id,[{...item,provider:'dajiala',body_text:'paid complete',body_complete:true}],'2026-10-02T00:00:00Z');
  store.upsertGatewayItems(source.id,[item],'2026-10-03T00:00:00Z');
  const paidXml=toAtom(source.id,source.name,store.listGatewayItems(source.id,initial));
  assert.equal(store.getSource(source.id).last_primary_content_at,initial);
  const vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql}=await vite.ssrLoadModule('/src/lib/db.ts');const sql=await getSql();
    const {parseFeedXml}=await vite.ssrLoadModule('/src/lib/server/rss-parser.ts');
    const {persistCollectedBatch}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    await sql.query(`insert into sources(id,platform,name,adapter,enabled) values('primary-clock','wechat','synthetic','wechat_gateway',false)`);
    const persist=async(xml:string,token:string)=>{
      await sql.query(`update sources set status='running',claim_token=$1 where id='primary-clock'`,[token]);
      await sql.query(`insert into jobs(id,source_id,platform,adapter) values($1,'primary-clock','wechat','wechat_gateway')`,[token]);
      const [row]=await sql.query(`select * from sources where id='primary-clock'`);
      await persistCollectedBatch(sql,row,token,{items:parseFeedXml(xml,'primary-clock','wechat'),meta:{provider:'primary',attempts:['primary'],paid_call:false}});
      return (await sql.query(`select last_content_at from sources where id='primary-clock'`))[0].last_content_at;
    };
    assert.equal(new Date(await persist(firstXml,'primary-first')).toISOString(),initial.replace('Z','.000Z'));
    assert.equal(new Date(await persist(paidXml,'primary-paid-cache')).toISOString(),initial.replace('Z','.000Z'),'paid cached body never refreshes primary clock');
    assert.equal((await sql.query(`select items_updated from jobs where id='primary-paid-cache'`))[0].items_updated,1,'actual body improvement still recorded');
    store.upsertGatewayItems(source.id,[{...item,body_text:'verified primary complete',body_complete:true}],completeAt);
    assert.equal(store.getSource(source.id).last_primary_content_at,completeAt,'T11 first actual completeness still advances');
    const completeXml=toAtom(source.id,source.name,store.listGatewayItems(source.id,initial));
    assert.equal(new Date(await persist(completeXml,'primary-complete')).toISOString(),completeAt.replace('Z','.000Z'));
    assert.equal((await sql.query(`select items_updated from jobs where id='primary-complete'`))[0].items_updated,0,'first verified primary completeness clock is independent from already cached paid completeness');
    for(const [token,xml] of [['primary-missing',completeXml.replace(/\s*<loom:primary_content_at>.*?<\/loom:primary_content_at>/,'')],
      ['primary-invalid',completeXml.replace(completeAt,'invalid')],['primary-future',completeXml.replace(completeAt,'2099-01-01T00:00:00Z')],
      ['primary-older',completeXml.replace(completeAt,initial)]]) {
      assert.equal(new Date(await persist(xml,token)).toISOString(),completeAt.replace('Z','.000Z'),'unknown/invalid/future/older evidence cannot refresh or regress');
    }
    await sql.query(`delete from items where source_id='primary-clock'`);await sql.query(`delete from jobs where source_id='primary-clock'`);await sql.query(`delete from sources where id='primary-clock'`);
  } finally {store.close();await vite.close();const pg=await (globalThis as any).__pgliteInstance__;if(pg)await pg.close();delete (globalThis as any).__pgliteInstance__;}
});

test('selected updated plus dc date stays editing-only in parser and real health percentiles', async () => {
  const vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql}=await vite.ssrLoadModule('/src/lib/db.ts');const sql=await getSql();
    const {parseFeedXml}=await vite.ssrLoadModule('/src/lib/server/rss-parser.ts');
    const {persistCollectedBatch}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const {getCollectionHealth}=await vite.ssrLoadModule('/src/lib/server/queries.ts');
    const xml='<feed><entry><id>000123</id><title>synthetic edit</title><updated>2026-10-01T00:00:00Z</updated><dc:date>2026-09-01T00:00:00Z</dc:date></entry></feed>';
    const items=parseFeedXml(xml,'mixed-date','rss');assert.equal(items[0].external_id,'000123');assert.equal(items[0].extra.rss_identity,'raw-v1');
    assert.equal(items[0].published_at,'2026-10-01T00:00:00Z');assert.equal(items[0].extra.publication_time_kind,'updated');
    await sql.query(`insert into sources(id,platform,name,adapter,status,claim_token,enabled) values('mixed-date','rss','synthetic','rss','running','mixed-date-job',false)`);
    await sql.query(`insert into jobs(id,source_id,platform,adapter) values('mixed-date-job','mixed-date','rss','rss')`);
    const [source]=await sql.query(`select * from sources where id='mixed-date'`);
    await persistCollectedBatch(sql,source,'mixed-date-job',{items,meta:{provider:'',attempts:['rss'],paid_call:false}});
    const health=await getCollectionHealth();assert.equal(health.discovery.observed,0);assert.equal(health.discovery.unknown,1);assert.equal(health.discovery.p50_seconds,null);assert.equal(health.discovery.p95_seconds,null);
    await sql.query(`delete from items where source_id='mixed-date'`);await sql.query(`delete from jobs where source_id='mixed-date'`);await sql.query(`delete from sources where id='mixed-date'`);
  } finally {await vite.close();const pg=await (globalThis as any).__pgliteInstance__;if(pg)await pg.close();delete (globalThis as any).__pgliteInstance__;}
});

test('actual attempts persist actionable metrics and keep request success separate from content progress', async () => {
  const vite = await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql} = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await getSql();
    const {runSourceJob,persistCollectedBatch} = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const {mapJob,mapSource,getCollectionHealth} = await vite.ssrLoadModule('/src/lib/server/queries.ts');
    await sql.query(`insert into sources(id,platform,name,handle,adapter) values('metrics','rss','metrics','https://metrics.example/feed','rss')`);
    const xml = `<rss><channel><item><guid>first</guid><title>First</title><description>Body</description><pubDate>2026-01-01T00:00:00Z</pubDate></item><item><title>Invalid</title><pubDate>invalid</pubDate></item></channel></rss>`;
    const io = {resolver:{async lookup(){return [{address:'93.184.216.34',family:4}];}},transport:async()=>({status:200,headers:{etag:'"first"'},body:new Response(xml).body})};
    assert.equal((await runSourceJob('metrics','manual',io)).items_new,1);
    let [raw] = await sql.query(`select * from jobs where source_id='metrics' order by started_at desc limit 1`);
    let job = mapJob(raw);
    assert.equal(job.adapter,'rss'); assert.equal(job.bytes,Buffer.byteLength(xml));
    assert.equal(job.items_found,2); assert.equal(job.items_invalid,1); assert.equal(job.items_new,1); assert.equal(job.items_updated,0);
    assert.ok(job.duration_ms >= 0); assert.equal(job.coverage.window_only,true); assert.equal(job.error_code,'');
    await sql.query(`update sources set last_content_at=now()-interval '2 days' where id='metrics'`);
    const [before] = await sql.query(`select * from sources where id='metrics'`);
    assert.equal((await runSourceJob('metrics','manual',io)).items_new,0);
    const [after] = await sql.query(`select * from sources where id='metrics'`);
    assert.equal(mapSource(before).last_content_at,mapSource(after).last_content_at);
    assert.ok(new Date(after.last_success_at)>=new Date(before.last_success_at));
    // Actual merge fills a missing body once; repeated likes/extra or old paid fallback does not refresh content.
    await sql.query(`update sources set status='running',claim_token='metric-merge' where id='metrics'`);
    await sql.query(`insert into jobs(id,source_id,platform,adapter) values('metric-merge','metrics','rss','rss')`);
    await sql.query(`update items set body='',extra='{}' where source_id='metrics'`);
    const [claimed] = await sql.query(`select * from sources where id='metrics'`);
    const item = {external_id:'first',title:'First',body:'Complete',author:'',url:'',media_type:'article',media_urls:[],thumbnail_url:'',views:null,likes:12,published_at:null,extra:{body_complete:true}};
    await persistCollectedBatch(sql,claimed,'metric-merge',{items:[item],meta:{provider:'',attempts:['rss'],paid_call:false}});
    [raw] = await sql.query(`select * from jobs where id='metric-merge'`);
    assert.equal(mapJob(raw).items_updated,1);
    const [progress] = await sql.query(`select last_content_at from sources where id='metrics'`);
    assert.ok(new Date(progress.last_content_at)>new Date(before.last_content_at));
    const retryAt = Date.now()+3600000;
    await runSourceJob('metrics','manual',{...io,transport:async()=>({status:429,headers:{'retry-after':new Date(retryAt).toUTCString()},body:new Response('').body})});
    [raw] = await sql.query(`select * from jobs where source_id='metrics' order by started_at desc limit 1`);
    job = mapJob(raw);
    assert.equal(job.error_code,'rate_limited'); assert.equal(job.items_found,null); assert.equal(job.bytes,null);
    assert.ok(Date.parse(job.retry_at)>=retryAt-1000);
    // A success from the same adapter is in the denominator; running work is excluded.
    const health = await getCollectionHealth();
    assert.equal(health.failed_sources.find((r:any)=>r.adapter==='rss').failed,1);
    const rate = health.adapter_jobs.find((r:any)=>r.adapter==='rss');
    assert.equal(rate.failed,1); assert.equal(rate.total,4);
    assert.equal(health.discovery.observed,1); assert.equal(health.discovery.unknown,0);
    assert.ok(health.discovery.p50_seconds>0); assert.equal(health.body.known,1); assert.equal(health.body.complete,1);
    assert.equal(health.oldest_due_age_minutes,null,'future Retry-After is not overdue');
    await sql.query(`insert into items(id,source_id,platform,external_id,published_at,extra) values
      ('unknown-time','metrics','rss','unknown',null,'{}'),
      ('future-time','metrics','rss','future',now()+interval '1 day','{}')`);
    await sql.query(`insert into sources(id,platform,name,adapter,status,claim_token,enabled)
      values('paid-old','wechat','paid-old','wechat_gateway','running','paid-old-job',false)`);
    await sql.query(`insert into jobs(id,source_id,platform,adapter) values('paid-old-job','paid-old','wechat','wechat_gateway')`);
    const [paidSource] = await sql.query(`select * from sources where id='paid-old'`);
    await persistCollectedBatch(sql,paidSource,'paid-old-job',{items:[{...item,extra:{provider:'dajiala',body_complete:true}}],
      meta:{provider:'dajiala',attempts:['primary','dajiala'],paid_call:true}});
    assert.equal((await sql.query(`select last_content_at from sources where id='paid-old'`))[0].last_content_at,null);
    const paid = mapJob((await sql.query(`select * from jobs where id='paid-old-job'`))[0]);
    assert.equal(paid.provider,'dajiala');assert.equal(paid.paid_call,true);
    await sql.query(`insert into sources(id,platform,name,handle,adapter,enabled) values('atom-updated','rss','edit-only','https://edit.example/','rss',true)`);
    await runSourceJob('atom-updated','manual',{...io,transport:async()=>({status:200,headers:{},body:new Response(
      `<feed><entry><id>edit-only</id><title>Edited</title><updated>2026-01-01T00:00:00Z</updated></entry></feed>`).body})});
    const observed = await getCollectionHealth();
    assert.equal(observed.discovery.unknown,3);assert.equal(observed.discovery.invalid_future,1);
    assert.equal(observed.discovery.observed,1);assert.equal(observed.body.known,2);assert.equal(observed.body.total,5);
    const [{id:mediaItem}] = await sql.query(`select id from items where source_id='metrics' and external_id='first'`);
    await sql.query(`insert into media_objects(id,item_id,source_url,status,attempts,created_at,next_attempt_at,claimed_at) values
      ('age-due',$1,'https://media.example/due','remote',1,now()-interval '90 minutes',null,null),
      ('age-cooling',$1,'https://media.example/cooling','error',1,now()-interval '200 minutes',now()+interval '1 hour',null),
      ('age-leased',$1,'https://media.example/leased','running',1,now()-interval '100 minutes',null,now()),
      ('age-manual',$1,'https://media.example/manual','dead',4,now()-interval '180 minutes',null,null)`,[mediaItem]);
    const ages = await getCollectionHealth();
    assert.ok(ages.pending_media_age_minutes>=200 && ages.pending_media_age_minutes<201);
    assert.ok(ages.oldest_due_media_age_minutes>=90 && ages.oldest_due_media_age_minutes<91);
    assert.equal(ages.media_cooling,1);assert.equal(ages.media_leased,1);assert.equal(ages.media_manual,1);
    await sql.query(`delete from media_objects where id like 'age-%'`);
    await sql.query(`delete from items where source_id in ('metrics','paid-old','atom-updated')`);
    await sql.query(`delete from jobs where source_id in ('metrics','paid-old','atom-updated')`);
    await sql.query(`delete from sources where id in ('metrics','paid-old','atom-updated')`);
  } finally {await vite.close();}
});

test('actual source job rolls back media failure, fences stale batches, and repairs replay', async () => {
  const vite = await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql} = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await getSql();
    const {runSourceJob,persistCollectedBatch} = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    await sql.query(`insert into sources(id,platform,name,handle,adapter,last_external_id)
      values('atomic','rss','atomic','https://feed.example/','rss','100')`);
    const query = sql.query.bind(sql), transaction = sql.transaction.bind(sql);
    let inject = true, reclaim = false, failCompletion = false;
    const statements: string[] = [];
    const guarded = (run: typeof query) => async (text:string, params?:unknown[]) => {
      statements.push(text);
      if (inject && /insert into media_objects/i.test(text)) throw new Error('injected_media_failure');
      if (failCompletion && /update jobs set status/i.test(text) && params?.[1]==='ok') throw new Error('injected_job_failure');
      return run(text,params);
    };
    sql.query = guarded(query);
    sql.transaction = (fn:any) => transaction((tx:any) => fn({query:guarded(tx.query.bind(tx))}));
    const io = {resolver:{async lookup(){return [{address:'93.184.216.34',family:4}];}},transport:async()=>{
      if(reclaim) await query(`update sources set claim_token='new-worker',last_error='new-state' where id='atomic'`);
      return {status:200,headers:{},body:new Response(`<rss><channel><item><guid>101</guid><title>New</title><enclosure url="https://img.example/cover.jpg" type="image/jpeg" /></item></channel></rss>`).body};
    }};
    assert.match((await runSourceJob('atomic','manual',io)).error,/injected_media_failure/);
    assert.deepEqual(await query(`select (select count(*)::int from items) items,(select count(*)::int from media_objects) media,last_external_id from sources where id='atomic'`),
      [{items:0,media:0,last_external_id:'100'}]);
    assert.equal((await query(`select status from jobs where source_id='atomic'`))[0].status,'error');
    inject = false;
    await query(`update sources set next_attempt_at=null where id='atomic'`);
    failCompletion = true;
    assert.match((await runSourceJob('atomic','manual',io)).error,/injected_job_failure/);
    assert.deepEqual(await query(`select (select count(*)::int from items) items,(select count(*)::int from media_objects) media,last_external_id from sources where id='atomic'`),
      [{items:0,media:0,last_external_id:'100'}]);
    failCompletion = false;
    await query(`update sources set next_attempt_at=null where id='atomic'`);
    assert.equal((await runSourceJob('atomic','manual',io)).items_new,1);
    const [{id}] = await query(`select id from items where source_id='atomic'`);
    await query(`delete from media_objects where item_id=$1`,[id]);
    assert.equal((await runSourceJob('atomic','reconcile',io)).items_new,0);
    assert.equal((await query(`select count(*)::int n from media_objects where item_id=$1`,[id]))[0].n,1);
    assert.equal((await runSourceJob('atomic','manual',io)).items_new,0);
    assert.equal((await query(`select count(*)::int n from media_objects where item_id=$1`,[id]))[0].n,1);
    const before = await query(`select * from items where id=$1`,[id]);
    reclaim = true;
    assert.equal((await runSourceJob('atomic','manual',io)).error,'scheduler_lease_lost');
    assert.deepEqual(await query(`select * from items where id=$1`,[id]),before);
    assert.equal((await query(`select claim_token,last_error from sources where id='atomic'`))[0].claim_token,'new-worker');
    const [record] = await query(`select * from sources where id='atomic'`);
    const oldJobs = await query(`select * from jobs where source_id='atomic' order by id`);
    assert.ok(statements.some(text=>/external_id=any\(\$2::text\[\]\)/i.test(text)));
    assert.ok(!statements.some(text=>/from items where source_id = \$1\s*$/i.test(text)));
    statements.length=0;
    await assert.rejects(()=>persistCollectedBatch(sql,record,'stale',{items:[],meta:{provider:'',attempts:[],paid_call:false}}),/scheduler_lease_lost/);
    assert.deepEqual(await query(`select * from sources where id='atomic'`),[record]);
    assert.deepEqual(await query(`select * from jobs where source_id='atomic' order by id`),oldJobs);
    assert.equal(statements.length,1);
    assert.ok(statements.some(text=>/for update/i.test(text)));
    // The helper contract also proves rollback AFTER the cursor write: RSS itself
    // is window-only, so use an explicit collector continuation for this check.
    await query(`update sources set claim_token='direct-job' where id='atomic'`);
    await query(`insert into jobs(id,source_id,platform) values('direct-job','atomic','rss')`);
    const [claimed] = await query(`select * from sources where id='atomic'`);
    const batch = {items:[{external_id:'102',title:'Next',body:'body',author:'',url:'',media_type:'image',
      media_urls:['https://img.example/next.jpg'],thumbnail_url:'',views:null,likes:null,published_at:null,extra:{}}],
      meta:{provider:'',attempts:['synthetic'],paid_call:false},next_cursor:'102',has_more:true,
      next_scan_state:{bootstrap:'backfill',boundary:'100',page:2},coverage:{complete:false}};
    inject = true;
    await assert.rejects(()=>persistCollectedBatch(sql,claimed,'direct-job',batch),/injected_media_failure/);
    assert.deepEqual(await query(`select * from sources where id='atomic'`),[claimed]);
    inject = false;failCompletion = true;
    await assert.rejects(()=>persistCollectedBatch(sql,claimed,'direct-job',batch),/injected_job_failure/);
    assert.deepEqual(await query(`select * from sources where id='atomic'`),[claimed]);
    assert.equal((await query(`select status from jobs where id='direct-job'`))[0].status,'running');
    assert.equal((await query(`select count(*)::int n from items where source_id='atomic' and external_id='102'`))[0].n,0);
    assert.equal((await query(`select count(*)::int n from media_objects where source_url='https://img.example/next.jpg'`))[0].n,0);
    failCompletion = false;
    assert.equal((await persistCollectedBatch(sql,claimed,'direct-job',batch)).items_new,1);
    assert.equal((await query(`select last_external_id from sources where id='atomic'`))[0].last_external_id,'102');
    assert.equal((await query(`select status from jobs where id='direct-job'`))[0].status,'ok');
  } finally {await vite.close();}
});

test('0024 retains a stored object and all references; ambiguous duplicate groups roll back', async () => {
  const pg = new PGlite();
  try {
    for (const name of readdirSync('migrations').filter(name=>name.endsWith('.sql') && name<'0024').sort()) {
      await pg.exec(readFileSync(path.join('migrations',name),'utf8'));
    }
    const migration = readFileSync('migrations/0024_media_identity.sql','utf8');
    await pg.exec(`insert into items(id,source_id,platform,external_id) values('article','source','rss','1');
      insert into media_objects(id,item_id,source_url,kind,status,object_key,public_url,sha256,bytes)
        values('stored-survivor','article','https://media.example/one','image','stored','original-object','https://stored.example/one','hash',42);
      insert into media_objects(id,item_id,source_url,kind) values
        ('empty-loser','article','https://media.example/one','image'),
        ('queue-first','article','https://media.example/two','image'),
        ('queue-second','article','https://media.example/two','image');
      insert into extract_jobs(id,item_id,media_id,target_key,kind,status,result_text)
        values('retained-extract','article','stored-survivor','stored-survivor','ocr','ok','retained');`);
    const stored = (await pg.query(`select * from media_objects where id='stored-survivor'`)).rows;
    const refs = (await pg.query(`select * from extract_jobs`)).rows;
    // Any referenced loser is unprovable; even otherwise-safe groups stay unchanged.
    await pg.exec(`insert into extract_jobs(id,item_id,media_id,target_key,kind)
      values('blocking-extract','article','empty-loser','empty-loser','ocr')`);
    const before = (await pg.query(`select * from media_objects order by id`)).rows;
    await assert.rejects(()=>pg.transaction(tx=>tx.exec(migration)),/media_identity_conflict/);
    assert.deepEqual((await pg.query(`select * from media_objects order by id`)).rows,before);
    await pg.exec(`delete from extract_jobs where id='blocking-extract';
      update media_objects set status='stored',object_key='other-object' where id='empty-loser'`);
    const incompatible = (await pg.query(`select * from media_objects order by id`)).rows;
    await assert.rejects(()=>pg.transaction(tx=>tx.exec(migration)),/media_identity_conflict/);
    assert.deepEqual((await pg.query(`select * from media_objects order by id`)).rows,incompatible);
    await pg.exec(`update media_objects set status='remote',object_key='' where id='empty-loser'`);
    await pg.transaction(tx=>tx.exec(migration));
    assert.deepEqual((await pg.query(`select * from media_objects where id='stored-survivor'`)).rows,stored);
    assert.deepEqual((await pg.query(`select * from extract_jobs`)).rows,refs);
    assert.equal((await pg.query<{n:number}>(`select count(*)::int n from media_objects`)).rows[0].n,2);
    await assert.rejects(()=>pg.exec(`insert into media_objects(id,item_id,source_url)
      values('repeat','article','https://media.example/one')`),/media_item_source_url_idx/);
  } finally {await pg.close();}
});

test('WeChat backfill is bounded and resumable; real reconciliation uses normalized URL identity', async () => {
  const vite = await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql} = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await getSql();
    const {runSourceJob} = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const {backfillWechatUrlKeys,reconcileTelegramIdentities} = await vite.ssrLoadModule('/src/lib/server/collection-identity.ts');
    await sql.query(`insert into sources(id,platform,name,handle,adapter) values('wx-atomic','wechat','wechat','https://feed.example/','rss')`);
    await sql.query(`insert into items(id,source_id,platform,external_id,url,extra)
      values('wx-kept','wx-atomic','wechat','legacy','https://mp.weixin.qq.com/s/story?scene=1','{"providers_seen":["primary"]}')`);
    let externalId='replacement';
    const io = {resolver:{async lookup(){return [{address:'93.184.216.34',family:4}];}},transport:async()=>({status:200,headers:{},
      body:new Response(`<rss><channel><item><guid>${externalId}</guid><title>Article</title><link>https://mp.weixin.qq.com/s/story?scene=2</link><enclosure url="https://img.example/wx.jpg" type="image/jpeg" /></item></channel></rss>`).body})};
    assert.match((await runSourceJob('wx-atomic','reconcile',io)).error,/wechat_identity_backfill_required/);
    await assert.rejects(()=>backfillWechatUrlKeys(sql,'wx-atomic',true),/workers_stopped/);
    await assert.rejects(()=>backfillWechatUrlKeys(sql,'wx-atomic',true,{workersStopped:true}),/pause_source/);
    await sql.query(`update sources set enabled=false where id='wx-atomic'`);
    await sql.query(`insert into items(id,source_id,platform,external_id,url)
      select 'wx-page-'||lpad(n::text,4,'0'),'wx-atomic','wechat',n::text,'invalid'
      from generate_series(1,501) n`);
    assert.equal((await backfillWechatUrlKeys(sql,'wx-atomic')).processed,500);
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='wx-atomic' and normalized_wechat_url is null`))[0].n,502);
    const first = await backfillWechatUrlKeys(sql,'wx-atomic',true,{workersStopped:true});
    assert.equal(first.processed,500);assert.equal(first.remaining,true);assert.equal(first.conflicts.length,499);
    const second = await backfillWechatUrlKeys(sql,'wx-atomic',true,{workersStopped:true});
    assert.equal(second.processed,2);assert.equal(second.remaining,false);assert.equal(second.conflicts.length,2);
    assert.equal((await backfillWechatUrlKeys(sql,'wx-atomic',true,{workersStopped:true})).processed,0);
    const [kept] = await sql.query(`select id,url,external_id,normalized_wechat_url from items where id='wx-kept'`);
    assert.deepEqual(kept,{id:'wx-kept',url:'https://mp.weixin.qq.com/s/story?scene=1',external_id:'legacy',normalized_wechat_url:'https://mp.weixin.qq.com/s/story'});
    await sql.query(`update sources set enabled=true,next_attempt_at=null where id='wx-atomic'`);
    assert.equal((await runSourceJob('wx-atomic','reconcile',io)).items_new,0);
    externalId='third-provider-id';
    assert.equal((await runSourceJob('wx-atomic','manual',io)).items_new,0);
    assert.equal((await sql.query(`select count(*)::int n from media_objects where item_id='wx-kept'`))[0].n,1);
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='wx-atomic'`))[0].n,502);
    // A merge must report a new unique-key collision rather than fail halfway through.
    await sql.query(`insert into sources(id,platform,name,handle,enabled) values('tg-media','telegram','tg','channel',false)`);
    await sql.query(`insert into items(id,source_id,platform,external_id) values('tg-old','tg-media','telegram','channel/1'),('tg-new','tg-media','telegram','1')`);
    await sql.query(`insert into media_objects(id,item_id,source_url) values('tg-media-old','tg-old','same'),('tg-media-new','tg-new','same')`);
    const report = await reconcileTelegramIdentities(sql,'tg-media',true,{workersStopped:true});
    assert.equal(report.applied,false);assert.equal(report.conflicts[0].reason,'media_source_collision');
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='tg-media'`))[0].n,2);
  } finally {await vite.close();}
});
