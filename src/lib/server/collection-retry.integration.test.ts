import test from "node:test";

test('keyword outcome metadata stays with its fenced attempt through real interleaving', async () => {
  const vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {getSql}=await vite.ssrLoadModule('/src/lib/db.ts');const sql=await getSql();
    const {runKeywordJob}=await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const {getCollectionHealth}=await vite.ssrLoadModule('/src/lib/server/queries.ts');
    await sql.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
    const query=sql.query.bind(sql);
    for(const mode of ['success','partial','error','exception','lost','exception-lost']) {
      const id=`interleave-${mode}`;
      const upstream=['partial','error','exception','exception-lost'].includes(mode);
      await query(`insert into keywords(id,phrase,platforms) values($1,'synthetic',$2::jsonb)`,[id,JSON.stringify(upstream?['rss']:['wechat'])]);
      let interleaved=false,firstJobId='',exception=false;
      const io={resolver:{async lookup(){return [{address:'93.184.216.34',family:4}];}},transport:async(url:URL)=>({
        status:mode==='partial' && url.hostname==='news.google.com'?200:429,
        headers:{'retry-after':'3600'},body:new Response('<rss><channel/></rss>').body})};
      sql.query=async(text:string,params:unknown[]=[])=>{
        if(text.includes('insert into jobs') && params[3]===id) firstJobId=String(params[0]);
        if(mode.startsWith('exception') && !exception && text.includes('select count(*)::int as n from items')) {
          if(mode==='exception-lost') {
            await query(`update keywords set claim_token='other-owner',last_error_code='rate_limited',next_attempt_at=now()+interval '1 day' where id=$1`,[id]);
            interleaved=true;
          }
          exception=true;throw Object.assign(new Error('synthetic failure'),{code:'network_error'});
        }
        if(mode==='lost' && !interleaved && text.includes('update keywords set') && text.includes("status = 'ok'")) {
          await query(`update keywords set claim_token='other-owner',last_error_code='rate_limited',next_attempt_at=now()+interval '1 day' where id=$1`,[id]);
          interleaved=true;
        }
        const result=await query(text,params);
        if(!mode.endsWith('lost') && !interleaved && text.includes('update keywords set') && text.includes('claim_token')) {
          interleaved=true;
          await query(`update keywords set platforms='["rss"]',next_attempt_at=null where id=$1`,[id]);
          // A real subsequent attempt takes the just-released claim before job1 completion.
          sql.query=query;
          await runKeywordJob(id,'manual',{...io,transport:async()=>({status:429,headers:{'retry-after':'7200'},body:new Response('').body})});
        }
        return result;
      };
      await runKeywordJob(id,'manual',io);sql.query=query;
      const [job]=await query('select * from jobs where id=$1',[firstJobId]);
      assert.ok(interleaved);
      assert.equal(job.status,['error','exception','lost','exception-lost'].includes(mode)?'error':'ok');
      assert.equal(job.error_code,mode==='success'?'':mode==='exception'?'network_error':mode.endsWith('lost')?'scheduler_lease_lost':'rate_limited');
      assert.ok(job.duration_ms>=0);
      if(mode==='success' || mode.endsWith('lost')) assert.equal(job.retry_at,null);
      else assert.ok(new Date(job.retry_at).getTime()<Date.now()+90*60000,'must not inherit second two-hour retry');
      assert.deepEqual(job.attempts,upstream?['google_news_zh','google_news_en','hacker_news']:[]);
      const rate=(await getCollectionHealth()).adapter_jobs.find((row:any)=>row.adapter==='keyword_index');
      assert.equal(rate.total,mode.endsWith('lost')?1:2);
      assert.equal(rate.failed,mode==='success'?1:rate.total,'first success must not inherit second failure in the numerator');
      if(mode.endsWith('lost')) assert.equal((await query('select claim_token from keywords where id=$1',[id]))[0].claim_token,'other-owner');
      await query('delete from jobs where keyword_id=$1',[id]);await query('delete from keywords where id=$1',[id]);
    }
  } finally {
    await vite.close();const pg=await (globalThis as any).__pgliteInstance__;if(pg)await pg.close();delete (globalThis as any).__pgliteInstance__;
  }
});
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
test("real scheduler manual and keyword entrances preserve partial Retry-After and due cadence", async () => {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true, watch: null },
  });
  try {
    const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    const { runSourceJob, runKeywordJob, tickDueSources } = await vite.ssrLoadModule(
      "/src/lib/server/scheduler.ts",
    );
    await sql.query(
      "insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'",
    );
    await sql.query(
      "insert into keywords(id,phrase,enabled) values('seed-marker','disabled',false)",
    );
    await sql.query(
      "insert into sources(id,platform,name,handle,adapter) values('retry','rss','fake','https://feed.example/','rss')",
    );
    const resolver = {
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    let calls = 0,
      throttle = true;
    const transport = async (url: URL) => {
      calls++;
      const fail = throttle && url.hostname !== "news.google.com";
      return {
        status: fail ? 429 : 200,
        headers: fail ? { "retry-after": "172800" } : {},
        body: new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode("<rss><channel><title>empty</title></channel></rss>"),
            );
            c.close();
          },
        }),
      };
    };
    const io = { resolver, transport };
    assert.match((await runSourceJob("retry", "manual", io)).error, /429/);
    const before = calls;
    assert.match((await runSourceJob("retry", "manual", io)).error, /冷却/);
    assert.equal(calls, before);
    await sql.query("update sources set enabled=false where id='retry'");
    await sql.query("update sources set enabled=true where id='retry'");
    assert.equal((await tickDueSources(5, {}, io)).ran, 0);
    assert.equal(calls, before);
    await sql.query(
      "insert into keywords(id,phrase,platforms) values('kw','synthetic','[\"rss\"]')",
    );
    await sql.query("update keywords set last_success_at='2026-01-01T00:00:00Z' where id='kw'");
    await runKeywordJob("kw", "manual", io);
    const [kw] = await sql.query("select * from keywords where id='kw'");
    assert.equal(kw.status, "error");
    assert.equal(kw.last_error_code, "rate_limited");
    assert.equal(kw.consecutive_failures, 1);
    assert.ok(new Date(kw.next_attempt_at).getTime() > Date.now() + 47 * 3600000);
    assert.equal(new Date(kw.last_success_at).toISOString(), "2026-01-01T00:00:00.000Z");
    const {mapJob,getCollectionHealth} = await vite.ssrLoadModule('/src/lib/server/queries.ts');
    const keywordJob = mapJob((await sql.query(`select * from jobs where keyword_id='kw' order by started_at desc limit 1`))[0]);
    assert.equal(keywordJob.status,'ok','partial upstream failure retains T08 outcome');
    assert.equal(keywordJob.adapter,'keyword_index');assert.equal(keywordJob.error_code,'rate_limited');
    assert.ok(keywordJob.duration_ms>=0);assert.ok(keywordJob.bytes>0);
    assert.equal(keywordJob.items_updated,0);assert.equal(keywordJob.items_invalid,null);assert.equal(keywordJob.coverage,null);
    assert.equal(keywordJob.attempts.length,3);assert.ok(Date.parse(keywordJob.retry_at)>Date.now()+47*3600000);
    const diagnostics = await getCollectionHealth();
    const keywordRate = diagnostics.adapter_jobs.find((row:any)=>row.adapter==='keyword_index');
    assert.equal(keywordRate.failed,1);assert.equal(keywordRate.total,1,'partial upstream failure belongs to job error numerator');
    const after = calls;
    assert.match((await runKeywordJob("kw", "manual", io)).error, /冷却/);
    assert.equal(calls, after);
    throttle = false;
    await sql.query("update keywords set next_attempt_at=now()-interval '1 second' where id='kw'");
    await runKeywordJob("kw", "keyword", io);
    const [ok] = await sql.query("select * from keywords where id='kw'");
    assert.equal(ok.consecutive_failures, 0);
    assert.ok(ok.last_success_at);
    // Manual invocations share the actual transport/body gate even outside the cron pool.
    let active = 0,
      peak = 0;
    const manualIo = {
      resolver,
      transport: async () => ({
        status: 200,
        headers: {},
        body: new ReadableStream({
          start(c) {
            active++;
            peak = Math.max(peak, active);
            setTimeout(() => {
              active--;
              c.enqueue(new TextEncoder().encode("<rss><channel/></rss>"));
              c.close();
            }, 10);
          },
        }),
      }),
    };
    const ids = Array.from({ length: 6 }, (_, n) => `manual-${n}`);
    for (const id of ids)
      await sql.query(
        "insert into sources(id,platform,name,handle,adapter) values($1,'rss','fake','https://shared.example/','rss')",
        [id],
      );
    const results = await Promise.all(ids.map((id) => runSourceJob(id, "manual", manualIo)));
    assert.ok(results.every((r) => r.error === ""));
    assert.equal(peak, 2);
    const done = calls;
    await runKeywordJob("kw", "keyword", io);
    assert.equal(calls, done);
  } finally {
    await vite.close();
    const pg = await (globalThis as any).__pgliteInstance__;
    if (pg) await pg.close();
    delete (globalThis as any).__pgliteInstance__;
  }
});

test("missing Bili mid and RSSHub feed persist permanent configuration failures without cursor changes", async () => {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true, watch: null },
  });
  try {
    const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    const { runSourceJob } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
    const { clearConfigurationFailure } = await vite.ssrLoadModule(
      "/src/lib/server/scheduler-atomic.ts",
    );
    for (const adapter of ["bilibili", "rsshub"]) {
      await sql.query(
        "insert into sources(id,platform,name,handle,adapter,last_external_id,scan_state,has_more) values($1,'bilibili','synthetic','username',$1,'cursor-kept','{\"bootstrap\":\"backfill\",\"page\":3}',true)",
        [adapter],
      );
      const io = {
        resolver: {
          async lookup() {
            throw new Error("unexpected DNS");
          },
        },
        transport: async () => {
          throw new Error("unexpected network");
        },
      };
      const result = await runSourceJob(adapter, "manual", io);
      assert.ok(result.error);
      const [row] = await sql.query(
        "select last_error_code,consecutive_failures,last_external_id,scan_state,has_more,extract(epoch from(next_attempt_at-last_scanned_at))/60 as delay from sources where id=$1",
        [adapter],
      );
      assert.equal(row.last_error_code, "config_error");
      assert.equal(Number(row.delay), 360);
      assert.equal(row.consecutive_failures, 1);
      assert.equal(row.last_external_id, "cursor-kept");
      assert.deepEqual(row.scan_state, { bootstrap: "backfill", page: 3 });
      assert.equal(row.has_more, true);
      await sql.query(
        "update sources set last_error_code='rate_limited',next_attempt_at=now()+interval '48 hours' where id=$1",
        [adapter],
      );
      await clearConfigurationFailure(sql, "sources", adapter);
      assert.match((await runSourceJob(adapter, "manual", io)).error, /冷却/);
    }
  } finally {
    await vite.close();
    const pg = await (globalThis as any).__pgliteInstance__;
    if (pg) await pg.close();
    delete (globalThis as any).__pgliteInstance__;
  }
});


test("history body failures persist long received cooldowns and block manual and scheduled admission", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  const vite = await createServer({configFile:false,logLevel:"silent",resolve:{alias:{"@":path.resolve("src")}},server:{middlewareMode:true,watch:null}});
  try {
    const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    const { runSourceJob, tickDueSources } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
    await sql.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
    await sql.query("insert into keywords(id,phrase,enabled) values('seed-marker','disabled',false)");
    let calls = 0;
    for (const status of [429, 503]) for (const fault of ["reset", "timeout"]) {
      const id = `history-${status}-${fault}`;
      const controller = new AbortController();
      globalThis.fetch = async input => {
        const url = String(input);
        if (url === "http://telethon:8787/health") return Response.json({ok:true,authorized:true,state:"ready"});
        assert.equal(url, "http://telethon:8787/v1/history");
        calls++;
        return new Response(new ReadableStream({start(stream) {
          if (fault === "reset") stream.error(new Error("secret reset"));
          else setTimeout(() => controller.abort(new DOMException("secret", "TimeoutError")), 20);
        }}), {status,headers:{"Retry-After":"172800"}});
      };
      await sql.query(`insert into sources(id,platform,name,handle,adapter,last_external_id,scan_state,has_more)
        values($1,'telegram','synthetic','channel','telegram_web','100','{"bootstrap":"backfill","boundary":"100"}',true)`, [id]);
      const before = Date.now();
      assert.match((await runSourceJob(id,"manual",{signal:controller.signal})).error, /Telethon HTTP/);
      const [row] = await sql.query("select * from sources where id=$1",[id]);
      assert.equal(row.last_error_code,"rate_limited", "scheduler classifies any upstream retry timestamp as cooldown");
      assert.ok(new Date(row.next_attempt_at).getTime() >= before + 172800000);
      assert.equal(row.last_external_id,"100");
      assert.deepEqual(row.scan_state,{bootstrap:"backfill",boundary:"100"});
      assert.equal(row.has_more,true);
      const [job] = await sql.query("select * from jobs where source_id=$1",[id]);
      assert.equal(job.error_code,row.last_error_code);
      assert.equal(new Date(job.retry_at).getTime(),new Date(row.next_attempt_at).getTime());
      const count = calls;
      assert.match((await runSourceJob(id,"manual")).error,/冷却/);
      assert.equal((await tickDueSources(5)).ran,0);
      assert.equal(calls,count,"neither entry may request history before the received cooldown");
    }
    assert.equal(calls,4);
  } finally {
    await vite.close(); globalThis.fetch = originalFetch; delete process.env.TELEGRAM_WORKER_URL;
    const pg = await (globalThis as any).__pgliteInstance__; if (pg) await pg.close(); delete (globalThis as any).__pgliteInstance__;
  }
});
