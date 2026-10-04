import test from "node:test";
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
