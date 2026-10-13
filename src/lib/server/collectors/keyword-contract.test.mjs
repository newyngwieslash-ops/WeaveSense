import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

/**
 * T08: keyword collection reports which sources worked, not "empty array".
 *
 * The defect this pins down: every request was wrapped in `catch { return [] }`,
 * so a total outage, a 429 and a genuine "no results" all reached the scheduler
 * as the same empty list — which was then recorded as a successful zero-hit run.
 *
 * `collectKeyword` is loaded through the Vite SSR runner because it imports
 * `@/lib/...` path aliases that bare Node cannot resolve; running it directly
 * would produce a fake failure (module-not-found) rather than a business result.
 */

const NEWS_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>n</title>
<item><title>命中新闻</title><link>https://example.com/n1</link><guid>n1</guid>
<description>关于 电池 的报道</description><pubDate>Tue, 15 Sep 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

const EMPTY_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>n</title></channel></rss>`;

const BILI_OK = JSON.stringify({
  code: 0,
  data: { result: [{ bvid: "BV1", title: "B站命中", description: "电池", author: "u", pic: "", play: 1, favorites: 2, pubdate: 1757900000 }] },
});

const BILI_PROVIDER_ERROR = JSON.stringify({ code: -412, message: "请求被拦截" });

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

const resolver = { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } };

/** Route each known host to a canned response; an unrouted host is a hard error. */
/**
 * @param {Record<string, (url: URL) => { status: number; body: string; contentType?: string }>} routes
 */
function routedTransport(routes) {
  /** @type {string[]} */
  const calls = [];
  /** @param {URL} url */
  const transport = async (url) => {
    calls.push(url.href);
    const route = routes[url.hostname];
    if (!route) throw new Error(`unrouted host: ${url.hostname}`);
    const { status, body, contentType = "text/xml" } = route(url);
    return { status, headers: { "content-type": contentType }, body: bodyOf(body) };
  };
  return { transport, calls };
}

/**
 * @param {unknown} transport
 * @param {number} [maxBytes]
 */
const io = (transport, maxBytes) => ({ resolver, transport, maxBytes });

/**
 * @typedef {{ source: string; status: string; count: number; error_code?: string }} Attempt
 * @typedef {{ url: string; external_id: string; extra: Record<string, unknown> }} Item
 * @typedef {{ items: Item[]; attempts: Attempt[] }} Batch
 * @typedef {(phrase: string, platforms: string[], io?: unknown) => Promise<Batch>} CollectKeyword
 * @typedef {(groups: Item[][], limit?: number) => Item[]} MergeKeywordResults
 */

/** @param {(collectKeyword: CollectKeyword, mergeKeywordResults: MergeKeywordResults) => Promise<void>} fn */
async function withKeyword(fn) {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true },
  });
  try {
    const mod = await vite.ssrLoadModule("/src/lib/server/collectors/keyword.ts");
    await fn(mod.collectKeyword, mod.mergeKeywordResults);
  } finally {
    await vite.close();
  }
}

test("keyword merge shares the 40-item budget equally across five full sources", async () => {
  await withKeyword(async (_, mergeKeywordResults) => {
    const groups = Array.from({ length: 5 }, (_, g) => Array.from({ length: 24 }, (_, i) => ({
      external_id: `${g}-${i}`, url: `https://example.com/${g}/${i}`, extra: { origin: `group-${g}` },
    })));
    const merged = mergeKeywordResults(groups);
    assert.equal(merged.length, 40);
    for (let g = 0; g < 5; g++) {
      assert.equal(merged.filter((x) => x.extra.origin === `group-${g}`).length, 8);
    }
    assert.deepEqual(merged.slice(0, 5), groups.map((group) => group[0]), "preserve source round-robin order");
    assert.equal(mergeKeywordResults([[groups[0][0]], [groups[0][0]]]).length, 1);
    assert.equal(mergeKeywordResults(groups, 0).length, 0);
    assert.equal(mergeKeywordResults(groups, -1).length, 0);
    assert.equal(mergeKeywordResults(groups, 100).length, 40);
    assert.equal(mergeKeywordResults(groups, 3).length, 3);
    for (const limit of [NaN, Infinity, 1.5]) assert.equal(mergeKeywordResults(groups, limit).length, 40);
    assert.deepEqual(mergeKeywordResults([]), []);
  });
});

test("keyword merge refills duplicate slots and drains remaining sources", async () => {
  await withKeyword(async (_, mergeKeywordResults) => {
    const shared = { external_id: "shared", url: "https://example.com/shared", extra: {} };
    const groups = Array.from({ length: 5 }, (_, g) => [shared, shared,
      ...Array.from({ length: 24 }, (_, i) => ({
        external_id: `${g}-${i}`, url: `https://example.com/${g}/${i}`, extra: { origin: `group-${g}` },
      })),
    ]);
    const merged = mergeKeywordResults(groups);
    assert.equal(merged.length, 40, "duplicate heads must not consume the unique-item budget");
    assert.equal(new Set(merged.map((item) => item.url)).size, 40);
    assert.deepEqual(merged.slice(0, 5), [shared, ...groups.slice(1).map((group) => group[2])],
      "skip duplicates within a source's turn, not after taking a fixed quota");
    assert.deepEqual(mergeKeywordResults([[], groups[1], []], 40), [shared, ...groups[1].slice(2)],
      "an exhausted source must not prevent peers filling available slots");
    const fallback = { external_id: "no-url", url: "", extra: {} };
    assert.deepEqual(mergeKeywordResults([[{ ...fallback, external_id: "" }, fallback], [fallback]]), [fallback]);
    const prefix = `https://example.com/${"x".repeat(320)}`;
    const distinct = [0, 1].map((i) => ({ external_id: String(i), url: `${prefix}/${i}`, extra: {} }));
    assert.deepEqual(mergeKeywordResults([distinct]), distinct, "dedupe uses the complete URL");
  });
});

test("saturated early news sources cannot starve bilibili in collectKeyword", async () => {
  await withKeyword(async (collectKeyword) => {
    /** @param {string} source */
    const feed = (source) => `<rss version="2.0"><channel><title>n</title>${
      Array.from({ length: 24 }, (_, i) => `<item><title>${source}-${i}</title>
        <link>https://example.com/${source}/${i}</link><guid>${source}-${i}</guid></item>`).join("")
    }</channel></rss>`;
    const { transport, calls } = routedTransport({
      "news.google.com": (url) => ({ status: 200, body: feed(
        url.searchParams.get("q")?.includes("site:youtube.com") ? "youtube_news"
          : url.searchParams.get("hl") === "zh-CN" ? "google_news_zh" : "google_news_en",
      ) }),
      "hnrss.org": () => ({ status: 200, body: feed("hacker_news") }),
      "api.bilibili.com": () => ({ status: 200, contentType: "application/json", body: JSON.stringify({
        code: 0, data: { result: Array.from({ length: 12 }, (_, i) => ({ bvid: `BV${i}`, title: `B站${i}` })) },
      }) }),
    });
    const batch = await collectKeyword("电池", [], io(transport));
    assert.equal(calls.length, 5);
    assert.equal(batch.items.length, 40);
    for (const attempt of batch.attempts) {
      assert.equal(attempt.status, "ok");
      assert.equal(attempt.count, attempt.source === "bilibili_search" ? 12 : 24,
        "attempt.count records the source return count before merge");
      assert.equal(batch.items.filter((item) => item.extra.origin === attempt.source).length, 8, attempt.source);
    }
    assert.equal(batch.attempts.length, 5);
  });
});

test("all sources succeeding yields items and ok attempts", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "news.google.com": () => ({ status: 200, body: NEWS_FEED }),
      "hnrss.org": () => ({ status: 200, body: EMPTY_FEED }),
      "api.bilibili.com": () => ({ status: 200, body: BILI_OK, contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["rss", "bilibili"], io(transport));
    assert.equal(batch.attempts.length, 4, "3 news/rss sources + bilibili");
    assert.ok(batch.attempts.every((a) => a.status === "ok"), JSON.stringify(batch.attempts));
    assert.ok(batch.items.length >= 2, "items from successful sources must survive");
  });
});

test("a source returning nothing is ok with count 0, not an error", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "news.google.com": () => ({ status: 200, body: EMPTY_FEED }),
      "hnrss.org": () => ({ status: 200, body: EMPTY_FEED }),
    });
    const batch = await collectKeyword("电池", ["rss"], io(transport));
    assert.ok(batch.attempts.every((a) => a.status === "ok" && a.count === 0), JSON.stringify(batch.attempts));
    assert.equal(batch.items.length, 0);
  });
});

test("every source failing is reported as error, with codes", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "news.google.com": () => ({ status: 500, body: "boom" }),
      "hnrss.org": () => ({ status: 429, body: "slow down" }),
      "api.bilibili.com": () => ({ status: 503, body: "{}", contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["rss", "bilibili"], io(transport));
    assert.equal(batch.items.length, 0);
    assert.ok(batch.attempts.every((a) => a.status === "error"), "a failure must not read as an empty result");
    const codes = batch.attempts.map((a) => a.error_code);
    assert.ok(codes.includes("http_error"), codes.join(","));
    assert.ok(codes.includes("rate_limited"), codes.join(","));
  });
});

test("a partial failure is visible while successful items still come back", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "news.google.com": () => ({ status: 200, body: NEWS_FEED }),
      "hnrss.org": () => ({ status: 500, body: "down" }),
      "api.bilibili.com": () => ({ status: 200, body: BILI_OK, contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["rss", "bilibili"], io(transport));
    assert.ok(batch.attempts.some((a) => a.status === "ok"));
    assert.ok(batch.attempts.some((a) => a.status === "error"));
    assert.ok(batch.items.length >= 1, "a failing peer must not discard a successful one's items");
  });
});

test("an invalid JSON payload is invalid_response, not a silent empty", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "api.bilibili.com": () => ({ status: 200, body: "not json at all", contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["bilibili"], io(transport));
    assert.equal(batch.items.length, 0);
    assert.equal(batch.attempts.length, 1);
    assert.equal(batch.attempts[0].status, "error");
    assert.equal(batch.attempts[0].error_code, "invalid_response");
  });
});

test("malformed, unsupported and over-limit feed responses are invalid_response", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport, calls } = routedTransport({
      "news.google.com": (url) => ({ status: 200, body: url.searchParams.get("hl") === "zh-CN"
        ? "<rss><channel>" : "<html><body>Not a feed</body></html>" }),
      "hnrss.org": () => ({ status: 200, body: `<feed>${"<entry><id>over-limit</id></entry>".repeat(1001)}</feed>` }),
    });
    const batch = await collectKeyword("电池", ["rss"], io(transport));
    assert.equal(calls.length, 3);
    assert.deepEqual(batch.items, []);
    assert.deepEqual(batch.attempts, ["google_news_zh", "google_news_en", "hacker_news"].map((source) =>
      ({ source, status: "error", count: 0, error_code: "invalid_response" })));
  });
});

test("a bilibili provider-level rejection is an error, not an empty result", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "api.bilibili.com": () => ({ status: 200, body: BILI_PROVIDER_ERROR, contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["bilibili"], io(transport));
    assert.equal(batch.attempts[0].status, "error");
    assert.equal(batch.items.length, 0);
  });
});

test("an oversized response is invalid_response rather than an unbounded read", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "api.bilibili.com": () => ({ status: 200, body: "x".repeat(5000), contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["bilibili"], io(transport, 1024));
    assert.equal(batch.attempts[0].status, "error");
    assert.equal(batch.attempts[0].error_code, "invalid_response");
  });
});

test("a network-level failure is network_error, not an empty result", async () => {
  await withKeyword(async (collectKeyword) => {
    const transport = async () => { throw new Error("ECONNRESET"); };
    const batch = await collectKeyword("电池", ["bilibili"], io(transport));
    assert.equal(batch.attempts[0].status, "error");
    assert.equal(batch.attempts[0].error_code, "network_error");
  });
});

test("a source the keyword does not ask for is never contacted", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport, calls } = routedTransport({
      "api.bilibili.com": () => ({ status: 200, body: BILI_OK, contentType: "application/json" }),
    });
    const batch = await collectKeyword("电池", ["bilibili"], io(transport));
    assert.ok(calls.every((/** @type {string} */ u) => u.includes("api.bilibili.com")), calls.join(", "));
    assert.deepEqual(batch.attempts.map((a) => a.source), ["bilibili_search"]);
  });
});

test("a local-only scope makes no external request at all", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport, calls } = routedTransport({});
    const batch = await collectKeyword("电池", ["wechat", "telegram"], io(transport));
    assert.deepEqual(calls, [], "local platforms must not trigger external search");
    assert.deepEqual(batch.attempts, [], "and nothing was contacted, so nothing failed");
    assert.deepEqual(batch.items, []);
  });
});

test("the reported source id matches the real route, so the UI cannot overclaim", async () => {
  await withKeyword(async (collectKeyword) => {
    const { transport } = routedTransport({
      "news.google.com": () => ({ status: 200, body: NEWS_FEED }),
      "hnrss.org": () => ({ status: 200, body: EMPTY_FEED }),
    });
    const batch = await collectKeyword("电池", ["rss"], io(transport));
    assert.deepEqual(batch.attempts.map((/** @type {{source: string}} */ a) => a.source).sort(),
      ["google_news_en", "google_news_zh", "hacker_news"]);

    // YouTube is a news-index query, not a full-site search: its id says so.
    const yt = routedTransport({ "news.google.com": () => ({ status: 200, body: EMPTY_FEED }) });
    const ytBatch = await collectKeyword("电池", ["youtube"], io(yt.transport));
    assert.deepEqual(ytBatch.attempts.map((/** @type {{source: string}} */ a) => a.source), ["youtube_news"]);
  });
});

test("an oversized image is refused, never trimmed into a corrupt data URL", async () => {
  // Trimming a JPEG mid-stream yields an invalid image that still costs a paid
  // vision call. The refusal must happen before any request is made. Loaded via
  // the Vite runner because extract.ts imports `@/` aliases.
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true },
  });
  const originalKey = process.env.XAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.XAI_API_KEY = "test-key-not-real";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  try {
    const { ocrBytes, OCR_MAX_BYTES } = await vite.ssrLoadModule("/src/lib/server/extract.ts");
    const tooBig = Buffer.alloc(OCR_MAX_BYTES + 1, 1);
    await assert.rejects(() => ocrBytes(tooBig, "image/jpeg"), /media_too_large/);
    assert.equal(calls, 0, "no model call may happen for an oversized image");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
    await vite.close();
  }
});
