import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

/**
 * T10: B站 pagination must not advance the cursor past unfetched middle.
 *
 * The defect: only page 1 (20 newest videos) was read, and the caller then moved
 * the source cursor to the newest of those — so anything published between the
 * stored cursor and that page was never collected and never noticed.
 *
 * `collectSource` is loaded through the Vite SSR runner because it imports `@/`
 * aliases and the collector graph; bare Node would fail on resolution, which
 * would be a fake failure rather than a statement about pagination.
 */

/** @type {{ lookup: (host?: string) => Promise<{address: string, family: number}[]> }} */
const resolver = { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } };

/** @param {string} text */
function bodyOf(text) {
  let sent = false;
  return {
    getReader: () => ({
      async read() {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: new TextEncoder().encode(text) };
      },
      async cancel() {},
      releaseLock() {},
    }),
  };
}

/** Serve B站 search pages from a synthetic channel of `bvid`s, newest first. */
/**
 * @param {string[]} allBvids
 * @param {{ pageSize?: number }} [options]
 */
function biliPages(allBvids, { pageSize = 20 } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @param {URL} url */
  const transport = async (url) => {
    calls.push(url.href);
    const page = Number(new URL(url.href).searchParams.get("pn") ?? "1");
    const start = (page - 1) * pageSize;
    const slice = allBvids.slice(start, start + pageSize);
    const body = JSON.stringify({
      code: 0,
      data: { list: { vlist: slice.map((bvid, i) => ({
        bvid, title: `视频 ${bvid}`, description: "", author: "u", pic: "",
        play: start + i, comment: 0, created: 1757900000, mid: 1,
      })) } },
    });
    return { status: 200, headers: { "content-type": "application/json" }, body: bodyOf(body) };
  };
  return { transport, calls };
}

/**
 * @typedef {{ external_id: string }} Item
 * @typedef {{ items: Item[]; meta: {attempts: string[]}; coverage?: { complete: boolean; window_only?: boolean; note?: string } }} Batch
 * @typedef {(source: Record<string, unknown>, io?: unknown) => Promise<Batch>} CollectSource
 */

/** @param {(collectSource: CollectSource, vite: import("vite").ViteDevServer) => Promise<void>} fn */
async function withCollector(fn) {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true },
  });
  try {
    const mod = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    await fn(mod.collectSource, vite);
  } finally {
    await vite.close();
  }
}

/** @param {string} lastExternalId */
const biliSource = (lastExternalId) => ({
  id: "bili-1",
  platform: "bilibili",
  name: "B站频道",
  handle: "12345",
  url: "https://space.bilibili.com/12345",
  feed_url: "",
  adapter: "bilibili",
  last_external_id: lastExternalId,
});

/** Newest-first ids: BV500 … BV001. */
const channel = Array.from({ length: 500 }, (_, i) => `BV${String(500 - i).padStart(3, "0")}`);

test("a known boundary inside the first page marks the batch complete", async () => {
  await withCollector(async (collectSource) => {
    const { transport, calls } = biliPages(channel);
    // The boundary is the 16th newest video — inside page 1 (20 per page).
    const batch = await collectSource(biliSource(channel[15]), { resolver, transport });
    assert.equal(batch.coverage?.complete, true);
    assert.equal(calls.length, 1, "one page is enough when the boundary is inside it");
    assert.ok(batch.items.length >= 16);
  });
});

test("a boundary on a later page keeps reading until it is found", async () => {
  await withCollector(async (collectSource) => {
    const { transport, calls } = biliPages(channel);
    // 30th newest: page 2. Read until the boundary, then stop.
    const batch = await collectSource(biliSource(channel[29]), { resolver, transport });
    assert.equal(batch.coverage?.complete, true, "reaching the boundary proves coverage");
    assert.equal(calls.length, 2, "pagination stops at the page holding the boundary");
    // The rest of the boundary's page is returned too (the page is the unit);
    // those older items are already known and are deduped on insert, so this is
    // about not splitting a page, not about skipping content.
    assert.ok(batch.items.length >= 30, `expected at least the boundary page, got ${batch.items.length}`);
    assert.equal(batch.items[0].external_id, channel[0], "newest first");
    assert.ok(batch.items.some((it) => it.external_id === channel[29]), "the boundary item is included, not skipped");
  });
});

test("a boundary beyond the page cap reports incomplete rather than claiming coverage", async () => {
  await withCollector(async (collectSource) => {
    const { transport, calls } = biliPages(channel);
    // The boundary is 300 videos back — far past the 5-page ceiling.
    const batch = await collectSource(biliSource(channel[299]), { resolver, transport });
    assert.equal(batch.coverage?.complete, false, "the page cap was hit before the boundary");
    assert.equal(batch.coverage?.note, "page_cap");
    assert.equal(calls.length, 5, "the scan must stop at the cap, not walk the whole channel");
    assert.ok(batch.items.length > 20, "but it must read more than one page");
  });
});

test("walking forward is not needed when the channel is smaller than the cap", async () => {
  await withCollector(async (collectSource) => {
    const short = channel.slice(0, 25);
    const { transport } = biliPages(short);
    const batch = await collectSource(biliSource("BV476"), { resolver, transport });
    assert.equal(batch.coverage?.complete, true, "a short final page proves the boundary");
    assert.equal(batch.items.length, 25);
  });
});

test("a cold start with no cursor is bounded and not claimed as complete coverage", async () => {
  await withCollector(async (collectSource) => {
    const { transport, calls } = biliPages(channel);
    const batch = await collectSource(biliSource(""), { resolver, transport });
    // With no known boundary there is nothing to prove coverage against, so the
    // scan is capped and must say it stopped early.
    assert.equal(batch.coverage?.complete, false);
    assert.ok(calls.length <= 5);
  });
});

test("duplicate videos across pages are returned once", async () => {
  await withCollector(async (collectSource) => {
    // A channel page that shifts between calls: page 2 repeats the tail of page 1.
    const stable = channel.slice(0, 60);
    const seen = new Set();
    /** @param {URL} url */
    const transport = async (url) => {
      const page = Number(new URL(url.href).searchParams.get("pn") ?? "1");
      const start = Math.max(0, (page - 1) * 20 - (page === 2 ? 5 : 0));
      const slice = stable.slice(start, start + 20);
      const body = JSON.stringify({ code: 0, data: { list: { vlist: slice.map((bvid) => ({
        bvid, title: `视频 ${bvid}`, description: "", author: "u", pic: "",
        play: 1, comment: 0, created: 1757900000, mid: 1,
      })) } } });
      return { status: 200, headers: { "content-type": "application/json" }, body: bodyOf(body) };
    };
    const batch = await collectSource(biliSource("BV441"), { resolver, transport });
    for (const item of batch.items) {
      assert.ok(!seen.has(item.external_id), `duplicate item returned: ${item.external_id}`);
      seen.add(item.external_id);
    }
  });
});

// --- T21: Bilibili rate limiting must be recognised, not treated as a plain failure

test("a provider rate-limit code is surfaced as rate_limited, not as a generic error", async () => {
  await withCollector(async (collectSource) => {
    // The real response Bilibili returns: HTTP 200 with a business error code.
    const transport = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: bodyOf(JSON.stringify({ code: -799, message: "请求过于频繁，请稍后再试", ttl: 1 })),
    });
    /** @type {Error | null} */
    let error = null;
    try {
      await collectSource(biliSource(""), { resolver: resolver, transport });
    } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
    assert.ok(error, "a rate-limited response must not look like success");
    // The classification must be machine-readable so the scheduler can back off
    // instead of retrying immediately at the same rate.
    assert.match(String(error.message), /rate_limited|-799/,
      `rate limiting must be identifiable; got: ${error.message}`);
  });
});

test("an ordinary business error is NOT classified as rate limiting", async () => {
  await withCollector(async (collectSource) => {
    const transport = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: bodyOf(JSON.stringify({ code: -404, message: "啥都木有" })),
    });
    /** @type {Error | null} */
    let error = null;
    try {
      await collectSource(biliSource(""), { resolver: resolver, transport });
    } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
    assert.ok(error);
    assert.ok(!/rate_limited/.test(String(error.message)),
      "a not-found must not be misreported as throttling");
  });
});

const offlineEnv = {
  DATABASE_URL: "", NODE_ENV: "test", LOOM_MODEL_CONFIG: path.resolve(".superpowers/nonexistent-offline-model.json"), XAI_API_KEY: "",
  TELEGRAM_WORKER_URL: "", MINIO_ENDPOINT: "", EXTRACT_AUTO: "false", AUTO_ANALYZE: "false",
  AGENT_ASYNC_RESEARCH_ENABLED: "false", AGENT_WORKER_ENABLED: "false", AGENT_OPENCODE_WORKER_ENABLED: "false",
  AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false",
};
Object.assign(process.env, offlineEnv);

/** @param {string[]} ids @param {boolean} [ascending] */
function feedOf(ids, ascending = false) {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>Offline feed</title>${ids.map((id, i) =>
    `<entry><id>${id}</id><title>Item ${id}</title><link href="https://example.org/${id}"/><updated>2026-10-13T00:00:${String(ascending ? i : 59-i).padStart(2,"0")}Z</updated><content>body</content></entry>`).join("")}</feed>`;
}
/** @param {string[]} ids @param {boolean} [fallback] @param {boolean} [ascending] */
function feedIo(ids, fallback = false, ascending = false) {
  let calls = 0;
  return { resolver, transport: async () => {
    calls += 1;
    return { status: fallback && calls === 1 ? 503 : 200, headers: { "content-type": "application/atom+xml" }, body: bodyOf(feedOf(ids, ascending)) };
  } };
}
/** @param {string} adapter @param {string} [previous] @param {string} [platform] */
const feedSource = (adapter, previous = "", platform = "rss") => ({
  id: `window-${adapter}`, platform, name: "Window feed", handle: "offline", url: "https://example.org/feed",
  feed_url: "https://example.org/feed", adapter, last_external_id: previous,
});

test("every finite feed route records initial, overlap, gap and empty window coverage", async () => {
  const previousEnv = { WECHAT_GATEWAY_URL: process.env.WECHAT_GATEWAY_URL, WECHAT_GATEWAY_TOKEN: process.env.WECHAT_GATEWAY_TOKEN };
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "offline-token";
  const originalFetch = globalThis.fetch;
  try {
    await withCollector(async (collectSource) => {
      for (const adapter of ["rss", "youtube", "telegram_web", "rsshub", "bilibili", "wechat_gateway", "fallback"]) {
        for (const [ids, previous, note] of /** @type {[string[], string, string][]} */ ([
          [["new", "old"], "", "initial_window"], [["new", "old"], "old", "window_overlap"],
          [["new"], "old", "window_gap"], [[], "old", "empty_window"],
        ])) {
          globalThis.fetch = async () => new Response(feedOf(ids), { headers: {
            "X-Loom-Provider": "primary", "X-Loom-Attempts": "primary", "X-Loom-Paid-Call": "false",
          } });
          const result = await collectSource(feedSource(adapter === "fallback" ? "youtube" : adapter, previous), feedIo(ids, adapter === "fallback"));
          assert.equal(result.items.length, ids.length, adapter);
          assert.deepEqual(result.coverage, { complete: false, window_only: true, note }, adapter);
          if (adapter === "fallback") assert.deepEqual(result.meta.attempts, ["youtube", "rss"]);
        }
      }
      globalThis.fetch = async () => { throw new Error("unexpected internal request"); };
      const webpage = await collectSource({ ...feedSource("telegram_web", "offline/1", "telegram"), feed_url: "" }, {
        resolver, transport: async () => ({ status: 200, headers: { "content-type": "text/html" },
          body: bodyOf('<div class="tgme_widget_message " data-post="offline/2"><div class="tgme_widget_message_text">Hello</div><time datetime="2026-10-13T00:00:00Z"></time></div>') }),
      });
      assert.deepEqual(webpage.coverage, { complete: false, window_only: true, note: "window_gap" });
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Real scheduler entry: A05 extends this replay instead of testing a copied cursor formula.
test("runSourceJob preserves capped history cursors and records window discovery warnings", async () => {
  await withCollector(async (_collectSource, vite) => {
    const { runSourceJob } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
    const { getSql, getPglite } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    try {
      for (const source of [biliSource("BV201"), feedSource("rss", "old")]) {
        await sql.query(`insert into sources (id,platform,name,handle,url,feed_url,adapter,last_external_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8)`, [source.id, source.platform, source.name, source.handle, source.url, source.feed_url, source.adapter, source.last_external_id]);
      }
      const bili = await runSourceJob("bili-1", "manual", { resolver, transport: biliPages(channel).transport });
      assert.equal(bili.error, "");
      assert.equal((await sql.query("select last_external_id from sources where id='bili-1'"))[0].last_external_id, "BV201");
      assert.deepEqual((await sql.query("select coverage from jobs where source_id='bili-1'"))[0].coverage,
        { complete: false, note: "page_cap" });
      const overlap = await runSourceJob("window-rss", "manual", feedIo(["new", "old"]));
      assert.equal(overlap.error, "");
      assert.equal((await sql.query("select last_external_id from sources where id='window-rss'"))[0].last_external_id, "new");
      assert.deepEqual((await sql.query("select coverage from jobs where source_id='window-rss'"))[0].coverage,
        { complete: false, window_only: true, note: "window_overlap" });
      const gap = await runSourceJob("window-rss", "manual", feedIo(["newer"]));
      assert.equal(gap.error, "");
      assert.equal((await sql.query("select last_external_id from sources where id='window-rss'"))[0].last_external_id, "newer");
      const jobs = await sql.query("select coverage from jobs where source_id='window-rss' order by started_at desc");
      assert.equal(jobs[0].coverage.note, "window_gap");
      await sql.query("update sources set last_external_id='20' where id='window-rss'");
      assert.equal((await runSourceJob("window-rss", "manual", feedIo(["10"]))).error, "");
      assert.equal((await sql.query("select last_external_id from sources where id='window-rss'"))[0].last_external_id, "20", "numeric windows retain monotonic cursor guard");
      const undatedIo = {
        resolver, transport: async () => ({ status: 200, headers: { "content-type": "application/atom+xml" },
          body: bodyOf('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>unknown</id><updated>invalid</updated></entry><entry><id>anchor</id></entry></feed>') }),
      };
      await sql.query("update sources set last_external_id='anchor' where id='window-rss'");
      assert.equal((await runSourceJob("window-rss", "manual", undatedIo)).error, "");
      assert.equal((await sql.query("select last_external_id from sources where id='window-rss'"))[0].last_external_id, "anchor", "undated opaque windows retain a present anchor");
      await sql.query(`insert into sources (id,platform,name,adapter,feed_url)
        values ('invalid-window','rss','Invalid date window','rss','https://example.org/feed')`);
      const invalidIo = {
        resolver, transport: async () => ({ status: 200, headers: { "content-type": "application/atom+xml" },
          body: bodyOf('<feed><entry><id>unknown</id><updated>invalid</updated></entry></feed>') }),
      };
      for (const round of [0, 1]) {
        assert.deepEqual(await runSourceJob("invalid-window", "manual", invalidIo),
          { items_found: 1, items_new: round ? 0 : 1, error: "" }, "invalid date first window and replay succeed");
        assert.deepEqual(await sql.query("select status,last_external_id,last_published_at from sources where id='invalid-window'"),
          [{ status: "ok", last_external_id: "unknown", last_published_at: null }]);
        assert.deepEqual(await sql.query("select external_id,published_at from items where source_id='invalid-window'"),
          [{ external_id: "unknown", published_at: null }], "replay keeps one normalized item");
        const [job] = await sql.query("select status,items_found,items_new,coverage from jobs where source_id='invalid-window' order by started_at desc limit 1");
        assert.deepEqual(job, { status: "ok", items_found: 1, items_new: round ? 0 : 1,
          coverage: { complete: false, window_only: true, note: round ? "window_overlap" : "initial_window" } });
      }
      for (const mode of ["rss", "telegram-dated", "telegram-undated", "telegram-equal"]) {
        const telegram = mode.startsWith("telegram");
        const source = { ...feedSource(telegram ? "telegram_web" : "rss", "", telegram ? "telegram" : "rss"), id: mode,
          feed_url: telegram ? "" : "https://example.org/feed" };
        await sql.query(`insert into sources (id,platform,name,handle,url,feed_url,adapter)
          values ($1,$2,$3,$4,$5,$6,$7)`, [source.id, source.platform, source.name, source.handle, source.url, source.feed_url, source.adapter]);
        for (const round of [0, 1]) {
          const ids = telegram ? [`offline/${9007199254740993n + BigInt(round)}`, `offline/${9007199254740994n + BigInt(round)}`]
            : round ? ["new", "newer"] : ["old", "new"];
          const io = telegram ? { resolver, transport: async () => ({ status: 200, headers: { "content-type": "text/html" },
            body: bodyOf(ids.map((id, i) => `<div class="tgme_widget_message " data-post="${id}"><div class="tgme_widget_message_text">Hello</div>${mode === "telegram-undated" ? "" : `<time datetime="2026-10-13T00:00:0${mode === "telegram-equal" ? 0 : i}Z"></time>`}</div>`).join("")) }) }
            : feedIo(ids, false, true);
          assert.equal((await runSourceJob(source.id, "manual", io)).error, "");
          assert.equal((await sql.query("select last_external_id from sources where id=$1", [source.id]))[0].last_external_id,
            ids[1], `${mode} ascending window anchor`);
          const [job] = await sql.query("select coverage from jobs where source_id=$1 order by started_at desc limit 1", [source.id]);
          assert.equal(job.coverage.note, round ? "window_overlap" : "initial_window", mode);
        }
      }
    } finally {
      await (await getPglite()).close();
      for (const key of ["__pgliteInstance__", "__pgliteMigrateChain__", "__pgBootstrapPromise__"]) Reflect.deleteProperty(globalThis, key);
    }
  });
});


test("legacy Telethon results keep coverage unknown and retain incremental cursor compatibility", async () => {
  process.env.TELEGRAM_WORKER_URL = "https://telethon.example";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).endsWith("/health")
    ? Response.json({ ok: true, authorized: true })
    : Response.json({ items: [{ external_id: "9007199254740994", title: "Offline", body: "body", author: "channel",
      url: "https://t.me/offline/2", media_type: "text", media_urls: [], thumbnail_url: "", views: null, likes: null,
      published_at: null, extra: {} }] });
  try {
    await withCollector(async (collectSource, vite) => {
      const source = { ...feedSource("telegram_web", "9007199254740993", "telegram"), feed_url: "" };
      assert.equal((await collectSource(source)).coverage, undefined);
      const { runSourceJob } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
      const { getSql, getPglite } = await vite.ssrLoadModule("/src/lib/db.ts");
      const sql = await getSql();
      try {
        await sql.query(`insert into sources (id,platform,name,handle,adapter,last_external_id)
          values ($1,$2,$3,$4,$5,$6)`, [source.id, source.platform, source.name, source.handle, source.adapter, source.last_external_id]);
        assert.equal((await runSourceJob(source.id)).error, "");
        assert.equal((await sql.query("select last_external_id from sources where id=$1", [source.id]))[0].last_external_id, "9007199254740994");
        assert.deepEqual((await sql.query("select coverage from jobs where source_id=$1", [source.id]))[0].coverage, {});
      } finally {
        await (await getPglite()).close();
        for (const key of ["__pgliteInstance__", "__pgliteMigrateChain__", "__pgBootstrapPromise__"]) Reflect.deleteProperty(globalThis, key);
      }
    });
  } finally { globalThis.fetch = originalFetch; process.env.TELEGRAM_WORKER_URL = ""; }
});
