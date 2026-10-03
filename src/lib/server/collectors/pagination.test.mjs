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
 * @typedef {{ items: Item[]; coverage?: { complete: boolean; note?: string } }} Batch
 * @typedef {(source: Record<string, unknown>, io?: unknown) => Promise<Batch>} CollectSource
 */

/** @param {(collectSource: CollectSource) => Promise<void>} fn */
async function withCollector(fn) {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true },
  });
  try {
    const mod = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    await fn(mod.collectSource);
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
