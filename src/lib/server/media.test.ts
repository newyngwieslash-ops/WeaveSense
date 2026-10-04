import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createServer } from "vite";
import type { Sql } from "../db.ts";
import type { OutboundTransport } from "./outbound-policy.ts";

test("media queue: actual ingest, SQL leases/retries and fixed storage boundary", async (t) => {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true, watch: null },
  });
  const originalFetch = globalThis.fetch;
  try {
    const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql: Sql = await getSql();
    const media = await vite.ssrLoadModule("/src/lib/server/media.ts");
    const { getNodesStatus } = await vite.ssrLoadModule("/src/lib/server/nodes.ts");
    const { prod } = await vite.ssrLoadModule("/src/lib/server/config.ts");
    Object.assign(prod, {
      minioEndpoint: "http://storage.fixture",
      minioAccessKey: "fake-key",
      minioSecretKey: "fake-secret",
      minioBucket: "fixture",
      minioPublicUrl: "https://display.fixture",
    });
    let now = Date.parse("2026-10-04T00:00:00Z"),
      status = 200,
      mime = "image/jpeg",
      size = 4;
    let requests = 0,
      uploads = 0,
      storageStatus = 200;
    let retryAfter = "",
      storageRetryAfter = "";
    let duringUpload: (() => Promise<void>) | undefined;
    const objects = new Map<string, Uint8Array>();
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      assert.equal(target.origin, "http://storage.fixture");
      assert.equal(init?.redirect, "error", "signed storage never follows redirects");
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      if (init?.method === "GET")
        return new Response(new Uint8Array(objects.get(target.pathname) ?? []), { status: 200 });
      assert.equal(init?.method, "PUT");
      uploads++;
      if (storageStatus === 200)
        objects.set(target.pathname, new Uint8Array(init.body as Uint8Array));
      await duringUpload?.();
      return new Response("", {
        status: storageStatus,
        headers: { "retry-after": storageRetryAfter },
      });
    };
    const transport: OutboundTransport = async () => {
      requests++;
      return {
        status,
        headers: { "content-type": mime, "retry-after": retryAfter },
        body: new Response(new Uint8Array(size)).body!,
      };
    };
    const io = {
      resolver: {
        async lookup() {
          return [{ address: "93.184.216.34", family: 4 }];
        },
      },
      transport,
      now: () => now,
    };
    const ingest = (limit = 1) => media.ingestPending(limit, io);
    const row = async (id = "m") =>
      (await sql.query<any>("select * from media_objects where id=$1", [id]))[0];
    const reset = async (urls = ["https://cdn.example/no-extension"], kind = "video") => {
      await sql.query("delete from extract_jobs");
      await sql.query("delete from media_objects");
      await sql.query("delete from items");
      await sql.query(
        `insert into items(id,source_id,platform,external_id,media_urls,thumbnail_url)
        values('i','s','rss','1',$1::jsonb,$2)`,
        [JSON.stringify(urls), urls[0]],
      );
      for (const [i, url] of urls.entries())
        await sql.query(
          `insert into media_objects(id,item_id,source_url,public_url,kind)
        values($1,'i',$2,$2,$3)`,
          [i ? `m${i}` : "m", url, kind],
        );
      status = 200;
      retryAfter = "";
      storageRetryAfter = "";
      mime = "image/jpeg";
      size = 4;
      requests = 0;
      uploads = 0;
      storageStatus = 200;
      duringUpload = undefined;
      objects.clear();
      now = Date.parse("2026-10-04T00:00:00Z");
    };

    await t.test(
      "single atomic winner, expiry replaces token and consumes an attempt",
      async () => {
        await reset();
        const claims = await Promise.all([
          media.claimMedia(sql, "a", now),
          media.claimMedia(sql, "b", now),
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal((await row()).attempts, 1);
        assert.equal(await media.claimMedia(sql, "c", now + media.MEDIA_LEASE_MS - 1), null);
        now += media.MEDIA_LEASE_MS;
        assert.equal((await media.claimMedia(sql, "c", now)).claim_token, "c");
        assert.equal((await row()).attempts, 2);
        for (let n = 0; n < 2; n++) {
          now += media.MEDIA_LEASE_MS;
          await media.claimMedia(sql, `claim-${n}`, now);
        }
        now += media.MEDIA_LEASE_MS;
        assert.equal(await media.claimMedia(sql, "exhausted", now), null);
        assert.equal((await row()).status, "dead");
        assert.equal((await row()).attempts, 4);
        assert.match((await row()).error, /attempts_exhausted/);
      },
    );

    await t.test(
      "503 recovers after persisted one-minute backoff; three retries mean four attempts",
      async () => {
        await reset();
        status = 503;
        for (const [index, delay] of [60_000, 300_000, 900_000].entries()) {
          assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
          assert.equal((await row()).status, "error");
          assert.equal((await row()).attempts, index + 1);
          assert.equal(new Date((await row()).next_attempt_at).getTime(), now + delay);
          assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
          now += delay;
        }
        assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
        assert.equal((await row()).status, "dead");
        assert.equal((await row()).attempts, 4);
        now += 86_400_000;
        assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        assert.equal(requests, 4);
        assert.equal(await media.replayMedia(sql, "m"), true);
        assert.equal((await row()).attempts, 0);
        status = 200;
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal(await media.replayMedia(sql, "m"), false);
        await reset();
        status = 503;
        await ingest();
        now += 60_000;
        status = 200;
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal((await row()).attempts, 2);
      },
    );

    await t.test(
      "permanent URL, missing object and size failures dead-letter; historical errors need explicit replay",
      async () => {
        for (const code of ["private", "404", "410", "too-large"]) {
          await reset([
            code === "private" ? "http://127.0.0.1/secret" : "https://cdn.example/file",
          ]);
          if (code === "404" || code === "410") status = Number(code);
          if (code === "too-large") size = 25 * 1024 * 1024 + 1;
          assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
          assert.equal((await row()).status, "dead");
          assert.equal(uploads, 0);
          assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        }
        await reset();
        await sql.query("update media_objects set status='error',error='historical' where id='m'");
        assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        assert.equal(await media.replayMedia(sql, "missing"), false);
        assert.equal(await media.replayMedia(sql, "m"), true);
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal((await row()).source_url, "https://cdn.example/no-extension");
      },
    );

    await t.test(
      "upload succeeds but item DB write rolls back, then overwrites the same key",
      async () => {
        await reset();
        const transaction = sql.transaction.bind(sql);
        let fail = true;
        sql.transaction = (fn) =>
          transaction((tx) =>
            fn({
              query: async <T>(text: string, params?: unknown[]) => {
                if (fail && /update items/i.test(text)) {
                  fail = false;
                  throw new Error("synthetic_db_failure");
                }
                return tx.query<T>(text, params);
              },
            }),
          );
        try {
          assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
        } finally {
          sql.transaction = transaction;
        }
        assert.equal((await row()).status, "error");
        assert.deepEqual((await getNodesStatus()).media, {
          total: 1,
          remote: 1,
          stored: 0,
          error: 0,
        });
        assert.equal((await row()).public_url, (await row()).source_url);
        assert.equal(objects.size, 1);
        const key = (await row()).object_key;
        assert.equal(key, "i/m");
        assert.deepEqual(
          (await sql.query<any>("select media_urls from items where id='i'"))[0].media_urls,
          ["https://cdn.example/no-extension"],
        );
        now += 60_000;
        mime = "image/png";
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal((await row()).object_key, key);
        assert.equal(uploads, 2);
        assert.equal(objects.size, 1);
        assert.equal((await row()).public_url, "https://display.fixture/i/m");
      },
    );

    await t.test("actual extractItem defers uploaded/uncommitted MIME then extracts each target once after recovery", async () => {
      await reset(["https://cdn.example/cover", "https://cdn.example/ready-cover"]);
      await sql.query("update items set body='original body' where id='i'");
      const previousKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "synthetic-fixture-key";
      const { extractItem } = await vite.ssrLoadModule("/src/lib/server/extract.ts");
      const fixtureFetch = globalThis.fetch;
      let modelCalls = 0, storedReads = 0;
      globalThis.fetch = async (url, init) => {
        const target = new URL(String(url));
        if (target.origin === "https://api.x.ai") {
          assert.equal(target.pathname, "/v1/chat/completions", "cover must never reach ASR");
          const request = JSON.parse(String(init?.body));
          assert.equal(request.model, "grok-4.5");
          assert.match(request.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
          modelCalls++;
          return Response.json({ choices: [{ message: { content: "synthetic cover text" } }] });
        }
        if (init?.method === "GET") storedReads++;
        return fixtureFetch(url, init);
      };
      const transaction = sql.transaction.bind(sql);
      let fail = true;
      sql.transaction = fn => transaction(tx => fn({ query: async <T>(text: string, params?: unknown[]) => {
        if (fail && /update items/i.test(text)) { fail = false; throw new Error("synthetic_item_commit_failure"); }
        return tx.query<T>(text, params);
      } }));
      try {
        try { assert.deepEqual(await ingest(), { stored: 0, errors: 1 }); }
        finally { sql.transaction = transaction; }
        assert.equal((await row()).status, "error");
        assert.equal((await row()).content_type, "");
        assert.equal((await row()).object_key, "i/m");
        assert.ok(objects.has("/fixture/i/m"), "failed metadata commit still has the uploaded object");
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 }, "independent target stores while the first is cooling");

        const beforeRecovery = await extractItem("i");
        assert.equal(beforeRecovery.ok, false);
        assert.equal(beforeRecovery.ran, 1, "ready target can extract without spending on uncommitted target");
        assert.equal(modelCalls, 1); assert.equal(storedReads, 1);
        assert.deepEqual(await sql.query("select media_id,status,attempts from extract_jobs order by media_id"),
          [{ media_id: "m1", status: "ok", attempts: 1 }]);
        for (let n = 0; n < 3; n++) {
          const deferred = await extractItem("i");
          assert.equal(deferred.ok, false); assert.equal(deferred.ran, 0);
        }
        assert.equal(modelCalls, 1); assert.equal(storedReads, 1);
        assert.equal((await sql.query<any>("select pipeline_status from items where id='i'"))[0].pipeline_status,
          "ingested", "one already-ok job cannot complete an item with a deferred target");
        assert.equal((await sql.query<any>("select count(*)::int n from extract_jobs where media_id='m'"))[0].n, 0);

        now += 60_000;
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal((await row()).content_type, "image/jpeg");
        assert.deepEqual(await extractItem("i"), { ok: true, ran: 1 });
        assert.deepEqual(await extractItem("i"), { ok: true, ran: 0 });
        assert.equal(modelCalls, 2); assert.equal(storedReads, 2);
        assert.deepEqual(await sql.query("select media_id,status,attempts from extract_jobs order by media_id"),
          [{ media_id: "m", status: "ok", attempts: 1 }, { media_id: "m1", status: "ok", attempts: 1 }]);
        const [item] = await sql.query<any>("select body,pipeline_status from items where id='i'");
        assert.equal(item.pipeline_status, "extracted");
        assert.ok(item.body.startsWith("original body"));
        assert.equal((item.body.match(/synthetic cover text/g) ?? []).length, 2);

        await reset();
        await sql.query("update media_objects set status='stored',object_key='historical-missing-mime' where id='m'");
        assert.equal((await extractItem("i")).ok, false, "historical missing MIME is deferred, never guessed");
        assert.equal((await sql.query<any>("select count(*)::int n from extract_jobs"))[0].n, 0);
        assert.equal(modelCalls, 2); assert.equal(storedReads, 2);
      } finally {
        sql.transaction = transaction;
        globalThis.fetch = fixtureFetch;
        if (previousKey === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = previousKey;
      }
    });

    await t.test("actual extractPending limit1 skips dead/cooling-only newest work and revisits recovered media", async () => {
      const previousKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "synthetic-fixture-key";
      const { extractItem, extractPending } = await vite.ssrLoadModule("/src/lib/server/extract.ts");
      const fixtureFetch = globalThis.fetch;
      let modelCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://api.x.ai/v1/chat/completions") {
          modelCalls++;
          return Response.json({ choices: [{ message: { content: "synthetic queue text" } }] });
        }
        return fixtureFetch(url, init);
      };
      try {
        for (const cooling of [false, true]) {
          await reset(); now = Date.now(); modelCalls = 0;
          assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
          await sql.query("update items set collected_at=$1::timestamptz where id='i'", [new Date(now-86_400_000).toISOString()]);
          await sql.query(`insert into items(id,source_id,platform,external_id,media_urls,collected_at)
            values('blocker','s','rss','blocker','["https://cdn.example/blocker","https://cdn.example/sibling"]'::jsonb,$1::timestamptz)`,
          [new Date(now).toISOString()]);
          await sql.query(`insert into media_objects(id,item_id,source_url,public_url,kind)
            values('blocker-media','blocker','https://cdn.example/blocker','https://cdn.example/blocker','video')`);
          status = cooling ? 429 : 404; retryAfter = cooling ? String(48*60*60) : "";
          assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
          assert.equal((await row('blocker-media')).status, cooling ? "error" : "dead");
          const deadline = cooling ? new Date((await row('blocker-media')).next_attempt_at).getTime() : now;
          if (cooling) assert.ok(deadline >= now+48*60*60_000);
          await sql.query(`insert into media_objects(id,item_id,source_url,public_url,kind)
            values('sibling','blocker','https://cdn.example/sibling','https://cdn.example/sibling','image')`);
          status = 200; retryAfter = "";
          assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
          assert.equal((await extractItem('blocker')).ran, 1);
          assert.equal(modelCalls, 1);

          assert.deepEqual(await extractPending(1), { ran: 1, errors: 0 }, "completed sibling plus waiting target must not block older ready media");
          assert.equal(modelCalls, 2);
          assert.equal((await sql.query<any>("select pipeline_status from items where id='i'"))[0].pipeline_status, "extracted");
          assert.equal((await sql.query<any>("select pipeline_status from items where id='blocker'"))[0].pipeline_status, "ingested");
          assert.equal((await sql.query<any>("select count(*)::int n from extract_jobs where media_id='blocker-media'"))[0].n, 0);
          assert.deepEqual(await extractPending(1), { ran: 0, errors: 0 });
          assert.equal(await media.replayMedia(sql, 'blocker-media', now), true);
          if (cooling) {
            assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
            assert.deepEqual(await extractPending(1), { ran: 0, errors: 0 });
            now = deadline;
          }
          assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
          assert.deepEqual(await extractPending(1), { ran: 1, errors: 0 });
          assert.deepEqual(await extractPending(1), { ran: 0, errors: 0 });
          assert.equal(modelCalls, 3);
          assert.deepEqual(await sql.query("select media_id,status,attempts from extract_jobs order by media_id"),
            [{ media_id: "blocker-media", status: "ok", attempts: 1 }, { media_id: "m", status: "ok", attempts: 1 },
              { media_id: "sibling", status: "ok", attempts: 1 }]);
        }
      } finally {
        globalThis.fetch = fixtureFetch;
        if (previousKey === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = previousKey;
      }
    });

    await t.test("fallback window identity, duplicate convergence and lease admission match actual runner", async () => {
      await reset(); now = Date.now();
      await sql.query("delete from media_objects");
      const urls = ["ignored", "https://cdn.example/a", "https://cdn.example/a", "https://cdn.example/b",
        "https://cdn.example/c", "https://cdn.example/outside-window"];
      await sql.query("update items set media_urls=$1::jsonb,collected_at=$2::timestamptz where id='i'",
        [JSON.stringify(urls), new Date(now).toISOString()]);
      const previousKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "synthetic-fixture-key";
      const { extractPending } = await vite.ssrLoadModule("/src/lib/server/extract.ts");
      const { extractTargetKey, EXTRACT_LEASE_MINUTES } = await vite.ssrLoadModule("/src/lib/server/extract-targets.ts");
      const aKey = extractTargetKey({ id: "", source_url: urls[1], public_url: urls[1] });
      const fixtureFetch = globalThis.fetch;
      let modelCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://api.x.ai/v1/chat/completions") {
          modelCalls++;
          return Response.json({ choices: [{ message: { content: "synthetic fallback text" } }] });
        }
        return fixtureFetch(url, init);
      };
      try {
        assert.deepEqual(await extractPending(1, io), { ran: 3, errors: 0 });
        assert.equal(modelCalls, 3); assert.equal(requests, 3, "duplicate URL reads once; fifth URL is outside original window");
        assert.equal((await sql.query<any>("select count(*)::int n from extract_jobs"))[0].n, 3);
        assert.deepEqual(await extractPending(1, io), { ran: 0, errors: 0 });
        await sql.query("update items set pipeline_status='ingested' where id='i'");
        assert.deepEqual(await extractPending(1, io), { ran: 0, errors: 0 }, "all-terminal jobs still converge pipeline state");
        assert.equal((await sql.query<any>("select pipeline_status from items where id='i'"))[0].pipeline_status, "extracted");
        assert.equal(modelCalls, 3); assert.equal(requests, 3);
        assert.deepEqual(await sql.query("select attempts from extract_jobs order by target_key"),
          [{ attempts: 1 }, { attempts: 1 }, { attempts: 1 }]);

        await sql.query("update items set pipeline_status='ingested' where id='i'");
        await sql.query(`update extract_jobs set status='running',attempts=1,started_at=now(),claim_token='fresh'
          where item_id='i' and target_key=$1`, [aKey]);
        await sql.query(`insert into items(id,source_id,platform,external_id,collected_at)
          values('older-ready','s','rss','older-ready',$1::timestamptz)`, [new Date(now-86_400_000).toISOString()]);
        await sql.query(`insert into media_objects(id,item_id,source_url,kind)
          values('older-media','older-ready','https://cdn.example/older','image')`);
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.deepEqual(await extractPending(1, io), { ran: 1, errors: 0 }, "fresh running fallback cannot block older ready item");
        assert.equal(modelCalls, 4);
        assert.equal((await sql.query<any>("select attempts from extract_jobs where target_key=$1", [aKey]))[0].attempts, 1);
        await sql.query(`update extract_jobs set started_at=now()-($2::integer * interval '1 minute')
          where item_id='i' and target_key=$1`, [aKey, EXTRACT_LEASE_MINUTES]);
        assert.deepEqual(await extractPending(1, io), { ran: 1, errors: 0 }, "lease at the inclusive boundary is admitted and reclaimed");
        assert.equal(modelCalls, 5);
        assert.equal((await sql.query<any>("select attempts from extract_jobs where target_key=$1", [aKey]))[0].attempts, 2);
        await sql.query("update items set pipeline_status='ingested' where id='i'");
        await sql.query(`update extract_jobs set status='running',attempts=1,started_at=null,claim_token='missing-clock'
          where item_id='i' and target_key=$1`, [aKey]);
        assert.deepEqual(await extractPending(1, io), { ran: 1, errors: 0 });
        assert.equal(modelCalls, 6);
        await sql.query("update items set pipeline_status='ingested' where id='i'");
        await sql.query("update extract_jobs set status='error',attempts=3 where item_id='i' and target_key=$1", [aKey]);
        assert.deepEqual(await extractPending(1, io), { ran: 0, errors: 0 }, "existing exhausted-job terminal semantics stay unchanged");
        assert.equal(modelCalls, 6);
        await sql.query(`insert into items(id,source_id,platform,external_id,collected_at)
          values('empty','s','rss','empty',$1::timestamptz),('outside','s','rss','outside',$1::timestamptz)`,
        [new Date(now+86_400_000).toISOString()]);
        for (let n = 0; n < 5; n++) await sql.query(`insert into media_objects(id,item_id,source_url,object_key,status,content_type,created_at)
          values($1,'outside',$1,$1,$2,$3,$4::timestamptz)`,
        [`outside-${n}`, n < 4 ? 'dead' : 'stored', n < 4 ? '' : 'image/jpeg', new Date(now+n*1000).toISOString()]);
        await sql.query("update items set pipeline_status='ingested' where id='older-ready'");
        assert.deepEqual(await extractPending(1, io), { ran: 0, errors: 0 }, "fifth media cannot falsely admit a waiting first-four window");
        assert.equal((await sql.query<any>("select pipeline_status from items where id='older-ready'"))[0].pipeline_status, "extracted");
        assert.deepEqual(await sql.query("select id,pipeline_status from items where id in ('empty','outside') order by id"),
          [{ id: 'empty', pipeline_status: 'ingested' }, { id: 'outside', pipeline_status: 'ingested' }]);
        assert.equal(modelCalls, 6);
        await sql.query(`insert into items(id,source_id,platform,external_id,media_urls,collected_at)
          values('oversize','s','rss','oversize','["https://cdn.example/too-large"]'::jsonb,$1::timestamptz)`,
        [new Date(now+2*86_400_000).toISOString()]);
        size = 25*1024*1024+1;
        assert.deepEqual(await extractPending(1, { ...io, maxBytes: Infinity }), { ran: 0, errors: 1 });
        assert.equal((await sql.query<any>("select error from extract_jobs where item_id='oversize'"))[0].error, 'response_too_large');
        assert.equal(modelCalls, 6, "test IO cannot widen the public cap or reach a model with oversized bytes");
      } finally {
        globalThis.fetch = fixtureFetch;
        if (previousKey === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = previousKey;
      }
    });

    await t.test(
      "expired completion and stale owner cannot change media or display URLs",
      async () => {
        await reset();
        duringUpload = async () => {
          now += media.MEDIA_LEASE_MS;
        };
        assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        assert.equal((await row()).status, "running");
        assert.equal((await row()).public_url, (await row()).source_url);
        const recovered = await media.claimMedia(sql, "replacement", now);
        assert.equal(recovered.attempts, 2);
        assert.equal(await media.replayMedia(sql, "m"), false);
        await reset();
        duringUpload = async () => {
          now += media.MEDIA_LEASE_MS;
          await media.claimMedia(sql, "new-owner", now);
        };
        assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        assert.equal((await row()).claim_token, "new-owner");
        assert.equal((await row()).status, "running");
        assert.deepEqual(
          (await sql.query<any>("select media_urls from items where id='i'"))[0].media_urls,
          ["https://cdn.example/no-extension"],
        );
        await reset();
        duringUpload = async () => {
          now += media.MEDIA_LEASE_MS;
          await media.claimMedia(sql, "failure-owner", now);
          throw new Error("synthetic_failed_old_upload");
        };
        assert.deepEqual(await ingest(), { stored: 0, errors: 0 });
        assert.equal((await row()).claim_token, "failure-owner");
        assert.equal((await row()).status, "running");
      },
    );

    await t.test(
      "complete DB outage after upload leaves a recoverable lease and same persisted object key",
      async () => {
        await reset();
        const query = sql.query.bind(sql),
          transaction = sql.transaction.bind(sql);
        sql.transaction = async () => {
          throw new Error("synthetic_database_offline");
        };
        sql.query = async <T>(text: string, params?: unknown[]) => {
          if (/status=\$3,error=\$4/.test(text)) throw new Error("synthetic_failure_write_offline");
          return query<T>(text, params);
        };
        try {
          await assert.rejects(ingest, /synthetic_failure_write_offline/);
        } finally {
          sql.query = query;
          sql.transaction = transaction;
        }
        assert.equal((await row()).status, "running");
        assert.equal((await row()).object_key, "i/m");
        assert.equal(objects.size, 1);
        now += media.MEDIA_LEASE_MS;
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal((await row()).attempts, 2);
        assert.equal(uploads, 2);
        assert.equal(objects.size, 1);
      },
    );

    await t.test(
      "overlapping workers preserve both display replacements and MIME classifies cover for OCR",
      async () => {
        await reset(["https://cdn.example/one", "https://cdn.example/two"]);
        assert.deepEqual(await Promise.all([ingest(), ingest()]), [
          { stored: 1, errors: 0 },
          { stored: 1, errors: 0 },
        ]);
        assert.equal(requests, 2);
        assert.equal(uploads, 2);
        const [item] = await sql.query<any>(
          "select media_urls,thumbnail_url from items where id='i'",
        );
        assert.deepEqual(item.media_urls, [
          "https://display.fixture/i/m",
          "https://display.fixture/i/m1",
        ]);
        assert.equal(item.thumbnail_url, "https://display.fixture/i/m");
        assert.equal((await row()).kind, "image");
        const { runExtractTargets } = await vite.ssrLoadModule(
          "/src/lib/server/extract-targets.ts",
        );
        const { getObject } = await vite.ssrLoadModule("/src/lib/server/storage.ts");
        let ocr = 0,
          asr = 0;
        const result = await runExtractTargets({
          sql,
          itemId: "i",
          targets: [await row()],
          load: async (target: any) => ({
            bytes: (await getObject(target.object_key)).bytes,
            contentType: target.content_type,
          }),
          ocr: async () => {
            ocr++;
            return { text: "cover", model: "fake-vision" };
          },
          asr: async () => {
            asr++;
            throw new Error("cover_not_audio");
          },
        });
        assert.equal(result.ran, 1);
        assert.equal(ocr, 1);
        assert.equal(asr, 0);
        await reset();
        mime = "application/octet-stream";
        await ingest();
        assert.equal((await row()).kind, "file");
        await reset();
        mime = "audio/mpeg";
        await ingest();
        assert.equal((await row()).kind, "audio");
      },
    );

    await t.test(
      "storage HTTP 503 schedules retry and a redirect never becomes another target",
      async () => {
        await reset();
        storageStatus = 503;
        assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
        assert.equal((await row()).status, "error");
        now += 60_000;
        storageStatus = 200;
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        await reset();
        storageStatus = 302;
        assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
        assert.equal((await row()).status, "dead");
        assert.equal(uploads, 1);
        assert.deepEqual((await getNodesStatus()).media, {
          total: 1,
          remote: 0,
          stored: 0,
          error: 1,
        });
      },
    );

    await t.test(
      "48-hour Retry-After survives manual replay, including exhausted dead rows",
      async () => {
        for (const exhausted of [false, true]) {
          await reset();
          now = Date.now();
          status = 429;
          retryAfter = String(48 * 60 * 60);
          if (exhausted) await sql.query("update media_objects set attempts=3 where id='m'");
          assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
          const failed = await row(),
            deadline = new Date(failed.next_attempt_at).getTime();
          assert.equal(failed.status, exhausted ? "dead" : "error");
          assert.ok(deadline >= now + 48 * 60 * 60_000);
          assert.equal(await media.replayMedia(sql, "m", now), true);
          assert.equal((await row()).attempts, 0);
          assert.equal(new Date((await row()).next_attempt_at).getTime(), deadline);
          assert.equal(await media.claimMedia(sql, "early-manual", now + 24 * 60 * 60_000), null);
          now = deadline;
          status = 200;
          retryAfter = "";
          assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
          assert.equal((await row()).attempts, 1);
        }
      },
    );

    await t.test("storage Retry-After also survives explicit replay", async () => {
      await reset();
      now = Date.now();
      storageStatus = 429;
      storageRetryAfter = String(48 * 60 * 60);
      assert.deepEqual(await ingest(), { stored: 0, errors: 1 });
      const deadline = new Date((await row()).next_attempt_at).getTime();
      assert.ok(deadline >= now + 48 * 60 * 60_000);
      assert.equal(await media.replayMedia(sql, "m", now), true);
      assert.equal(
        await media.claimMedia(sql, "early-storage-replay", now + 24 * 60 * 60_000),
        null,
      );
    });

    await t.test(
      "actual production entry cannot steal manual ingest; media retries retain 30-minute admission",
      async () => {
        await reset();
        now = Date.now();
        const base = now;
        const { runProductionTick } = await vite.ssrLoadModule("/src/lib/server/nodes.ts");
        await sql.query("delete from stage_windows");
        let automatic: any;
        duringUpload = async () => {
          automatic = await runProductionTick({ now: () => base });
        };
        assert.deepEqual(await ingest(), { stored: 1, errors: 0 });
        assert.equal(automatic.stored, 0);
        assert.equal(automatic.ingest_errors, 0);
        assert.equal(requests, 1);
        assert.equal(uploads, 1);
        await sql.query(
          `insert into media_objects(id,item_id,source_url,status,attempts,next_attempt_at)
        values('retry','i','http://127.0.0.1/private','error',1,$1::timestamptz)`,
          [new Date(base - 1).toISOString()],
        );
        assert.equal((await runProductionTick({ now: () => base + 60_000 })).stored, 0);
        assert.equal((await row("retry")).attempts, 1, "due retry cannot bypass the ingest window");
        await runProductionTick({ now: () => base + 30 * 60_000 });
        assert.equal((await row("retry")).attempts, 2);
        assert.equal((await row("retry")).status, "dead");
        assert.equal(
          (
            await sql.query<any>("select count(*)::int n from stage_windows where stage='ingest'")
          )[0].n,
          2,
        );
      },
    );

    await t.test(
      "unique enqueue preserves failed rows; signed storage reads enforce the media cap",
      async () => {
        await reset();
        await sql.query(
          "update media_objects set status='dead',attempts=4,error='historical' where id='m'",
        );
        assert.equal(
          await media.enqueueItemMedia("i", ["https://cdn.example/no-extension"], "image", sql),
          0,
        );
        assert.equal((await row()).status, "dead");
        const { getObject } = await vite.ssrLoadModule("/src/lib/server/storage.ts");
        objects.set("/fixture/large", new Uint8Array(25 * 1024 * 1024 + 1));
        await assert.rejects(() => getObject("large"), /response_too_large/);
        objects.set("/fixture/large", new Uint8Array(25 * 1024 * 1024));
        assert.equal((await getObject("large")).bytes.length, 25 * 1024 * 1024);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    const pg = await (globalThis as any).__pgliteInstance__;
    if (pg) await pg.close();
    delete (globalThis as any).__pgliteInstance__;
  }
});
