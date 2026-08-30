import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { toAtom } from "./atom.mjs";
import { createFixtureServer } from "./fixture-server.mjs";
import { canonicalWechatId, fetchPrimary } from "./primary.mjs";
import { authorize, createGateway, createGatewayServer, validateSourceInput } from "./server.mjs";
import { shouldReconcile } from "./state-machine.mjs";
import { openStore } from "./store.mjs";

test("ships a QA-only primary fixture and wires its host allowlist", async () => {
  const [compose, fixture] = await Promise.all([
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/primary.atom", import.meta.url), "utf8"),
  ]);
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(fixture);
  const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => String(entry.link?.["@_href"] ?? "").startsWith("https://mp.weixin.qq.com/")));
  assert.ok(entries.some((entry) => String(entry.content ?? "").length > 8_000));
  assert.ok(entries.some((entry) => entry["media:thumbnail"]?.["@_url"]));
  assert.match(compose, /wechat-fixture:\s*[\s\S]*profiles:\s*\["qa"\]/);
  assert.match(compose, /WECHAT_PRIMARY_ALLOWED_HOSTS:\s*\$\{WECHAT_PRIMARY_ALLOWED_HOSTS:\?[^}]+\}/);
  assert.equal((compose.match(/WECHAT_GATEWAY_TOKEN:\s*\$\{WECHAT_GATEWAY_TOKEN:\?[^}]+\}/g) ?? []).length, 2);
  assert.match(compose, /WECHAT_GATEWAY_URL:\s*\$\{WECHAT_GATEWAY_URL:-http:\/\/wechat-gateway:8790\}/);
});

test("serves the deterministic fixture without side effects on import", async (t) => {
  const fixture = await readFile(new URL("./fixtures/primary.atom", import.meta.url));
  const server = createFixtureServer(fixture).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const feed = await fetch(`${base}/primary.atom`);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type"), /application\/atom\+xml/);
  assert.match(await feed.text(), /<entry>/);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

const canonicalFixtures = [
  {
    input: [
      "https://mp.weixin.qq.com/s?__biz=MzA1&mid=2247480001&idx=2&sn=abc",
      " account-1 ",
      " title ",
      "2026-08-28T10:00:00Z",
    ],
    expected: "wx:MzA1:2247480001:2",
  },
  {
    input: [
      "https://mp.weixin.qq.com/s?sn=abc&scene=21&sessionid=1",
      "account-a",
      "title-a",
      "2026-08-28T10:00:00Z",
    ],
    expected: "wx:url:a2495b5f002a9fb6beae061b6b9e1738",
  },
  {
    input: ["not a url", " account-x ", " Title X ", "2026-08-28T10:00:00Z"],
    expected: "wx:fallback:63f04018cab0823e96ce9ef46e4d7277",
  },
];

test("requires an exact bearer token", () => {
  assert.equal(authorize(new Headers({ authorization: "Bearer gateway-test" }), "gateway-test"), true);
  assert.equal(authorize(new Headers({ authorization: "Bearer wrong" }), "gateway-test"), false);
});

test("requires a WeChat sample URL and HTTP feed", () => {
  assert.equal(validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  }, new Set(["feeds.internal"])).id, "wx-1");
  assert.throws(() => validateSourceInput({ id: "wx-1", name: "示例号" }), /sample_url/);
  assert.throws(() => validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example",
    sample_url: "http://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  }, new Set(["feeds.internal"])), /sample_url/);
  assert.throws(() => validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://untrusted.example/wx-1.atom",
  }, new Set(["feeds.internal"])), /allowed host/);
});

test("stores source health state in SQLite", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const source = validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example", priority: "high",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  });
  store.upsertSource(source, "2026-08-28T00:00:00.000Z");
  store.recordPrimaryFailure("wx-1", "2026-08-28T01:00:00.000Z");
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 1);
  store.upsertSource({ ...source, name: "改名后" }, "2026-08-28T01:30:00.000Z");
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 1);
  store.recordPrimarySuccess("wx-1", "2026-08-28T02:00:00.000Z");
  assert.equal(store.getSource("wx-1").last_primary_ok_at, "2026-08-28T02:00:00.000Z");
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 0);
  assert.equal(store.listSources().length, 1);
});

test("migrates an existing source database with paid-success history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wechat-store-"));
  const path = join(directory, "gateway.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`create table gateway_sources (
    source_id text primary key, account_id text not null, name text not null,
    priority text not null default 'normal', sample_url text not null,
    primary_feed_url text not null, last_primary_ok_at text,
    consecutive_primary_failures integer not null default 0,
    last_paid_check_at text, last_paid_result text not null default '',
    next_retry_at text, alert_state text not null default 'normal',
    created_at text not null, updated_at text not null
  );
  insert into gateway_sources
    (source_id, account_id, name, priority, sample_url, primary_feed_url,
      last_paid_check_at, last_paid_result, created_at, updated_at)
    values ('legacy', 'gh_legacy', '旧公众号', 'normal',
      'https://mp.weixin.qq.com/s/legacy', 'https://feeds.internal/legacy.atom',
      '2026-08-28T02:00:00.000Z', 'ok',
      '2026-08-28T00:00:00.000Z', '2026-08-28T02:00:00.000Z');
  create table provider_reservations (
    id integer primary key autoincrement, day text not null, provider text not null,
    estimate real not null, status text not null check (status in ('open', 'settled')),
    created_at text not null, settled_at text
  )`);
  legacy.close();
  const store = openStore(path);
  const columns = new DatabaseSync(path, { readOnly: true });
  t.after(async () => {
    columns.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.ok(columns.prepare("pragma table_info(gateway_sources)").all()
    .some(({ name }) => name === "last_paid_ok_at"));
  assert.ok(columns.prepare("pragma table_info(provider_reservations)").all()
    .some(({ name }) => name === "actual"));
  assert.match(columns.prepare("select sql from sqlite_master where name = 'provider_reservations'")
    .get().sql, /overrun/);
  assert.equal(store.getSource("legacy").last_paid_ok_at, "2026-08-28T02:00:00.000Z");
});

test("rolls back a failed store migration and closes its database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wechat-bad-store-"));
  const path = join(directory, "gateway.sqlite");
  let inspection;
  t.after(async () => {
    inspection?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(path);
  legacy.exec("create table gateway_sources (source_id text primary key)");
  legacy.close();
  assert.throws(() => openStore(path), /no such column/);
  inspection = new DatabaseSync(path);
  assert.equal(inspection.prepare("pragma table_info(gateway_sources)").all()
    .some(({ name }) => name === "last_paid_ok_at"), false);
});

test("reserves and adjusts provider spend atomically within both daily caps", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const first = store.tryReserveSpend("2026-08-28", "dajiala", 0.08, 0.10, 2);
  assert.match(String(first), /^\d+$/);
  assert.equal(store.getProviderBudgetState("2026-08-28", "dajiala", 0.10, 2), "warning");
  assert.equal(store.tryReserveSpend("2026-08-28", "dajiala", 0.08, 0.10, 2), false);
  store.adjustSpend(first, 0.06);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), {
    calls: 1,
    amount: 0.06,
  });
  store.adjustSpend(first, 0.06);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 1, amount: 0.06 });
  assert.throws(() => store.adjustSpend(first, 0.05), /conflict/);

  const second = store.tryReserveSpend("2026-08-28", "dajiala", 0.04, 0.10, 2);
  assert.match(String(second), /^\d+$/);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), {
    calls: 2,
    amount: 0.10,
  });
  assert.equal(store.getProviderBudgetState("2026-08-28", "dajiala", 0.10, 3), "budget_exhausted");
  assert.equal(store.getProviderBudgetState("2026-08-28", "dajiala", 1, 2), "budget_exhausted");
  assert.equal(store.getProviderBudgetState("2026-08-28", "dajiala", 0.12, 3), "warning");
  assert.throws(() => store.tryReserveSpend("2026-08-28", "dajiala", -0.01, 1, 2), /non-negative/);
  assert.throws(() => store.tryReserveSpend("2026-08-28", "dajiala", 0.01, 1, -1), /non-negative/);
  assert.throws(() => store.tryReserveSpend("huge", "dajiala", Number.MAX_VALUE,
    Number.MAX_VALUE, 1), /too large/);
  store.adjustSpend(second, -1);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 2, amount: 0.06 });
  store.adjustSpend(second, 0);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 2, amount: 0.06 });

  const queueA = store.tryReserveSpend("queue", "dajiala", 0.08, 1, 3);
  const queueB = store.tryReserveSpend("queue", "dajiala", 0.08, 1, 3);
  assert.notEqual(queueA, queueB);
  store.adjustSpend(queueA, 0.06);
  store.adjustSpend(queueA, 0.06);
  store.adjustSpend(queueB, 0.05);
  assert.deepEqual(store.getProviderUsage("queue", "dajiala"), { calls: 2, amount: 0.11 });
  assert.throws(() => store.adjustSpend(queueA, 0.04), /conflict/);

  const overrun = store.tryReserveSpend("overrun", "dajiala", 0.08, 0.08, 2);
  store.adjustSpend(overrun, 0.09);
  store.adjustSpend(overrun, 0.09);
  assert.deepEqual(store.getProviderUsage("overrun", "dajiala"), { calls: 1, amount: 0.09 });
  assert.equal(store.getProviderBudgetState("overrun", "dajiala", 0.08, 2), "budget_exhausted");
  assert.equal(store.tryReserveSpend("overrun", "dajiala", 0, 0.08, 2), false);
  assert.throws(() => store.adjustSpend(overrun, 0.08), /conflict/);
  assert.throws(() => store.adjustSpend("999999", 0.01), /reservation not found/);
  assert.deepEqual(store.getProviderUsage("empty", "dajiala"), { calls: 0, amount: 0 });
});

test("records paid checks without losing the last paid success", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const source = {
    id: "wx-paid", name: "付费兜底号", account_id: "gh_paid", priority: "normal",
    sample_url: "https://mp.weixin.qq.com/s/paid",
    primary_feed_url: "https://feeds.internal/wx-paid.atom",
  };
  store.upsertSource(source, "2026-08-28T00:00:00.000Z");
  store.recordPrimarySuccess(source.id, "2026-08-28T01:00:00.000Z");
  store.recordPaidResult(source.id, "ok", null, "paid_fallback", "2026-08-28T02:00:00.000Z");
  store.recordPaidResult(source.id, "technical_error", "2026-08-28T02:05:00.000Z",
    "degraded", "2026-08-28T02:01:00.000Z");
  store.recordPaidResult(source.id, "mapping_error", null, "alert", "2026-08-28T02:02:00.000Z");
  const saved = store.getSource(source.id);
  assert.equal(saved.last_primary_ok_at, "2026-08-28T01:00:00.000Z");
  assert.equal(saved.last_paid_ok_at, "2026-08-28T02:00:00.000Z");
  assert.equal(saved.last_paid_check_at, "2026-08-28T02:02:00.000Z");
  assert.equal(saved.last_paid_result, "mapping_error");
  assert.equal(saved.next_retry_at, null);
  assert.equal(saved.alert_state, "alert");
  store.recordPaidResult(source.id, "mapping_error", null, "alert", "2026-08-28T02:02:00.000Z");
  assert.throws(() => store.recordPaidResult(source.id, "technical_error", null, "degraded",
    "2026-08-28T02:02:00.000Z"), /conflict/);
  assert.throws(() => store.recordPaidResult(source.id, "technical_error", null, "degraded",
    "2026-08-28T02:01:00.000Z"), /older/);
  assert.equal(store.getSource(source.id).last_paid_result, "mapping_error");
  assert.throws(() => store.recordPaidResult(source.id, "other", null, "alert",
    "2026-08-28T03:00:00.000Z"), /result/);
  assert.throws(() => store.recordPaidResult(source.id, "ok", null, "warning",
    "2026-08-28T03:00:00.000Z"), /alertState/);
  assert.throws(() => store.recordPaidResult(source.id, "ok", null, "normal", "not-a-date"), /now/);
  assert.throws(() => store.recordPaidResult(source.id, "ok", null, "normal",
    "2026-02-31T03:00:00Z"), /now/);
  assert.throws(() => store.recordPaidResult(source.id, "technical_error", "tomorrow", "degraded",
    "2026-08-28T03:00:00.000Z"), /nextRetryAt/);
  assert.throws(() => store.recordPaidResult(source.id, "technical_error",
    "2026-08-28T25:00:00Z", "degraded", "2026-08-28T03:00:00.000Z"), /nextRetryAt/);
  assert.throws(() => store.recordPaidResult("missing", "ok", null, "normal",
    "2026-08-28T03:00:00.000Z"), /source not found/);
  store.recordPaidResult(source.id, "ok", null, "paid_fallback", "2026-08-28T03:00:00.900Z");
  assert.throws(() => store.recordPaidResult(source.id, "technical_error", null, "degraded",
    "2026-08-28T03:00:00.100Z"), /older/);
  assert.equal(store.getSource(source.id).last_paid_check_at, "2026-08-28T03:00:00.900Z");
  store.recordPaidResult(source.id, "ok", null, "paid_fallback", "2026-08-28T12:00:00+08:00");
});

test("paid success attribution rejects the future and never moves backward", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertSource({ id: "wx-attribution", name: "归属测试", account_id: "gh_attribution",
    priority: "normal", sample_url: "https://mp.weixin.qq.com/s/attribution",
    primary_feed_url: "https://feeds.internal/attribution.atom" }, "2026-08-28T00:00:00.000Z");
  const before = store.getSource("wx-attribution");
  assert.throws(() => store.recordPaidResult("wx-attribution", "ok", null, "paid_fallback",
    "2026-08-28T12:00:00.000Z", "2026-08-28T13:00:00.000Z"), /successAt/);
  assert.deepEqual(store.getSource("wx-attribution"), before);

  store.recordPaidResult("wx-attribution", "ok", null, "paid_fallback",
    "2026-08-29T16:20:00.000Z", "2026-08-29T16:10:00.000Z");
  store.recordPaidResult("wx-attribution", "ok", null, "paid_fallback",
    "2026-08-29T17:00:00.000Z", "2026-08-29T15:59:00.000Z");
  const saved = store.getSource("wx-attribution");
  assert.equal(saved.last_paid_check_at, "2026-08-29T17:00:00.000Z");
  assert.equal(saved.last_paid_ok_at, "2026-08-29T16:10:00.000Z");
  assert.equal(shouldReconcile(saved, new Date("2026-08-30T15:35:00.000Z")), false);
});

test("merges cached provider history without erasing article content", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const primary = {
    canonical_id: "wx:MzA1:9:1", account_id: "gh_example", account_name: "示例号",
    title: "原始标题", published_at: "2026-08-28T08:00:00.000Z",
    original_url: "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1",
    body_text: "完整正文", cover_url: "https://mmbiz.qpic.cn/cover.jpg",
    provider: "primary", discovered_at: "2026-08-28T09:00:00.000Z",
  };
  const source = {
    id: "wx-1", name: "示例号", account_id: "gh_example", priority: "normal",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  };
  store.upsertSource(source, "2026-08-28T00:00:00.000Z");
  assert.throws(() => store.upsertGatewayItems("missing", [primary]), /source not found/);
  store.upsertSource({ ...source, id: "wx-other", account_id: "gh_other" },
    "2026-08-28T00:00:00.000Z");
  assert.throws(() => store.upsertGatewayItems("wx-other", [primary]), /account_id/);
  store.upsertGatewayItems("wx-1", [primary], "2026-08-28T09:00:00.000Z");
  store.upsertGatewayItems("wx-1", [{ ...primary, title: "付费标题", body_text: "", cover_url: "",
    provider: "dajiala", discovered_at: "2026-08-28T10:00:00.000Z" }],
  "2026-08-28T10:00:00.000Z");
  const rows = store.listGatewayItems("wx-1", "2026-08-28T00:00:00.000Z");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "付费标题");
  assert.equal(rows[0].body_text, "完整正文");
  assert.equal(rows[0].cover_url, "https://mmbiz.qpic.cn/cover.jpg");
  assert.deepEqual(JSON.parse(rows[0].providers_seen), ["primary", "dajiala"]);
  assert.throws(() => store.upsertGatewayItems("wx-1", [
    { ...primary, canonical_id: "wx:MzA1:10:1" },
    { ...primary, canonical_id: "wx:MzA1:11:1", title: "" },
  ]), /title/);
  for (const [field, value] of [
    ["published_at", "yesterday"],
    ["published_at", "2026-02-31T08:00:00Z"],
    ["published_at", "2026-08-28T24:00:00Z"],
    ["discovered_at", "2026-08-28"],
    ["original_url", "http://mp.weixin.qq.com/s/unsafe"],
    ["original_url", "https://mp.weixin.qq.com.evil.example/s/unsafe"],
    ["cover_url", "https://127.0.0.1/private.jpg"],
  ]) {
    assert.throws(() => store.upsertGatewayItems("wx-1", [{ ...primary,
      canonical_id: `wx:bad:${field}:${value}`, [field]: value }]), new RegExp(field));
  }
  assert.throws(() => store.upsertGatewayItems("wx-1", [{ ...primary,
    account_id: "gh_other" }]), /account_id/);
  assert.equal(store.listGatewayItems("wx-1", "2026-08-28T00:00:00.000Z").length, 1);
  assert.deepEqual(store.listGatewayItems("wx-1", "2026-08-29T00:00:00.000Z"), []);
  assert.equal(store.deleteGatewayItemsBefore("2026-08-29T00:00:00.000Z"), 1);
  assert.deepEqual(store.listGatewayItems("wx-1", "2026-08-28T00:00:00.000Z"), []);
});

test("keeps the mirrored canonical algorithm in parity", () => {
  for (const { input, expected } of canonicalFixtures) {
    assert.equal(canonicalWechatId(...input), expected);
  }
});

test("normalizes at most 24 valid primary entries", async (t) => {
  const entries = Array.from({ length: 26 }, (_, index) => `
    <entry><title>标题 ${index}</title><published>2026-08-28T08:00:00+08:00</published>
    <link rel="alternate" href="https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=${index + 1}&amp;idx=1&amp;sn=abc"/>
    <content><![CDATA[正文 ${index}]]></content><media:thumbnail url="https://mmbiz.qpic.cn/${index}.jpg"/></entry>`).join("");
  const upstream = createServer((_req, res) => {
    res.setHeader("content-type", "application/atom+xml");
    res.end(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`);
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const { port } = upstream.address();
  const items = await fetchPrimary({
    account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${port}/feed.atom`,
  }, new Date("2026-08-28T09:00:00Z"), new Set(["127.0.0.1"]));
  assert.equal(items.length, 24);
  assert.equal(items[0].provider, "primary");
  assert.equal(items[0].discovered_at, "2026-08-28T09:00:00.000Z");
  assert.equal(items[0].cover_url, "https://mmbiz.qpic.cn/0.jpg");
});

test("rejects invalid primary article fields", async (t) => {
  const upstream = createServer((_req, res) => res.end(`
    <feed xmlns="http://www.w3.org/2005/Atom"><entry><title></title><published>invalid</published>
    <link href="https://example.com/not-wechat"/></entry></feed>`)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const { port } = upstream.address();
  await assert.rejects(fetchPrimary({
    account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${port}/feed.atom`,
  }, new Date(), new Set(["127.0.0.1"])), /invalid primary feed/);
});

test("accepts empty Atom, RSS, and RDF feeds but rejects an unknown root", async (t) => {
  const documents = [
    '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    '<rss version="2.0"><channel></channel></rss>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>',
  ];
  let current = documents[0];
  const upstream = createServer((_req, res) => res.end(current)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const source = { account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${upstream.address().port}/feed` };
  for (const document of documents) {
    current = document;
    assert.deepEqual(await fetchPrimary(source, new Date(), new Set(["127.0.0.1"])), []);
  }
  current = "<html><body>not a feed</body></html>";
  await assert.rejects(fetchPrimary(source, new Date(), new Set(["127.0.0.1"])), /invalid primary feed/);
});

test("keeps valid entries when sibling entries are invalid", async (t) => {
  const upstream = createServer((_req, res) => res.end(`
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>坏链接</title><published>2026-08-28T08:00:00+08:00</published><link href="http://mp.weixin.qq.com/s/bad"/></entry>
      <entry><title>有效文章</title><published>2026-08-28T08:00:00+08:00</published><link href="https://mp.weixin.qq.com/s/good"/></entry>
    </feed>`)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(JSON.parse(message));
  t.after(() => { console.warn = warn; });
  const items = await fetchPrimary({ account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${upstream.address().port}/feed` },
    new Date(), new Set(["127.0.0.1"]));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "有效文章");
  assert.equal(warnings[0].invalid_count, 1);
  assert.equal(warnings[0].event, "wechat_primary_invalid_entries");
});

test("rejects a chunked primary response above 8 MiB", async (t) => {
  const upstream = createServer((_req, res) => {
    res.setHeader("content-type", "application/xml");
    for (let index = 0; index < 9; index += 1) res.write(Buffer.alloc(1024 * 1024, 65));
    res.end();
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  await assert.rejects(fetchPrimary({ account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${upstream.address().port}/feed` },
    new Date(), new Set(["127.0.0.1"])), /body too large/);
});

test("revalidates every redirect against the feed host allowlist", async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${upstream.address().port}/feed` });
      return res.end();
    }
    res.end('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  await assert.rejects(fetchPrimary({ account_id: "gh_example", name: "示例号",
    primary_feed_url: `http://127.0.0.1:${upstream.address().port}/redirect` },
    new Date(), new Set(["127.0.0.1"])), /allowed host/);
});

test("serializes the required XML-safe Atom contract", () => {
  const xml = toAtom("wx-1", "示例<&号", [{
    canonical_id: "wx:MzA1:9:1", account_id: "gh_example", account_name: "示例号",
    title: "标题 <&", published_at: "2026-08-28T08:00:00+08:00",
    original_url: "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc",
    body_text: "正文 \u0001 ]]> 尾", cover_url: "https://mmbiz.qpic.cn/cover.jpg?a=1&b=2",
    provider: "primary", discovered_at: "2026-08-28T09:00:00Z",
  }]);
  assert.match(xml, /wx:MzA1:9:1/);
  assert.match(xml, /loom:provider>primary/);
  assert.match(xml, /media:thumbnail/);
  assert.match(xml, /]]]]><!\[CDATA\[>/);
  assert.equal(xml.includes("\u0001"), false);
  assert.doesNotThrow(() => new XMLParser().parse(xml));
});

test("serves authenticated source, health, and feed routes", async (t) => {
  const upstream = createServer((_req, res) => res.end(`
    <feed xmlns="http://www.w3.org/2005/Atom"><entry><title>标题</title>
    <published>2026-08-28T08:00:00+08:00</published>
    <link href="https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=9&amp;idx=1&amp;sn=abc"/></entry></feed>`)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const store = openStore(":memory:");
  const gateway = createGatewayServer({ store, token: "gateway-test",
    allowedFeedHosts: new Set(["127.0.0.1"]) }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => { upstream.close(); gateway.close(); store.close(); });
  const upstreamPort = upstream.address().port;
  const gatewayPort = gateway.address().port;
  const base = `http://127.0.0.1:${gatewayPort}`;
  assert.equal((await fetch(`${base}/v1/sources/missing/health`)).status, 401);
  const headers = { authorization: "Bearer gateway-test" };
  assert.equal((await fetch(`${base}/v1/sources/missing/health`, { headers })).status, 404);
  const invalid = await fetch(`${base}/v1/sources/wx-1`, {
    method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(invalid.status, 422);
  assert.equal("stack" in await invalid.json(), false);
  const saved = await fetch(`${base}/v1/sources/wx-1`, {
    method: "PUT", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "示例号", account_id: "gh_example", priority: "normal",
      sample_url: "https://mp.weixin.qq.com/s/example",
      primary_feed_url: `http://127.0.0.1:${upstreamPort}/feed.atom` }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true });
  const health = await fetch(`${base}/v1/sources/wx-1/health`, { headers });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).paid_configured, false);
  const feed = await fetch(`${base}/v1/feeds/wx-1.atom`, { headers });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type"), /application\/atom\+xml/);
  assert.match(await feed.text(), /<entry>/);
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 0);
});

test("an empty feed succeeds while an upstream failure is counted with a fixed error", async (t) => {
  let body = '<feed xmlns="http://www.w3.org/2005/Atom"></feed>';
  const upstream = createServer((_req, res) => res.end(body)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const store = openStore(":memory:");
  const gateway = createGatewayServer({ store, token: "gateway-test",
    allowedFeedHosts: new Set(["127.0.0.1"]) }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => { upstream.close(); gateway.close(); store.close(); });
  store.upsertSource({ id: "wx-empty", name: "示例号", account_id: "gh_example", priority: "normal",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: `http://127.0.0.1:${upstream.address().port}/feed` });
  const headers = { authorization: "Bearer gateway-test" };
  const base = `http://127.0.0.1:${gateway.address().port}`;
  assert.equal((await fetch(`${base}/v1/feeds/wx-empty.atom`, { headers })).status, 200);
  assert.equal(store.getSource("wx-empty").consecutive_primary_failures, 0);
  assert.ok(store.getSource("wx-empty").last_primary_ok_at);
  body = "<broken";
  const failed = await fetch(`${base}/v1/feeds/wx-empty.atom`, { headers });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "primary_feed_failed" });
  assert.equal(store.getSource("wx-empty").consecutive_primary_failures, 1);
});

const integrationSource = {
  id: "wx-integrated", name: "集成测试号", account_id: "gh_integrated", priority: "normal",
  sample_url: "https://mp.weixin.qq.com/s/integrated",
  primary_feed_url: "https://feeds.internal/integrated.atom",
};
const primaryItem = {
  canonical_id: "wx:MzPrimary:1:1", account_id: "gh_integrated", account_name: "集成测试号",
  title: "自建文章", published_at: "2026-08-28T10:00:00.000Z",
  original_url: "https://mp.weixin.qq.com/s?__biz=MzPrimary&mid=1&idx=1",
  body_text: "自建正文", cover_url: "https://mmbiz.qpic.cn/primary.jpg",
  provider: "primary", discovered_at: "2026-08-28T10:01:00.000Z",
};
const paidListItem = {
  account_id: "gh_integrated", account_name: "集成测试号", title: "付费文章",
  published_at: "2026-08-28T11:00:00.000Z",
  original_url: "https://mp.weixin.qq.com/s?__biz=MzPaid&mid=2&idx=1",
  cover_url: "https://mmbiz.qpic.cn/paid.jpg", provider: "dajiala",
};

function gatewayFixture(t, {
  clock = "2026-08-28T12:00:00.000Z",
  primary = async () => [primaryItem],
  paid = null,
  budget = { rmb: 20, calls: 250 },
} = {}) {
  const store = openStore(":memory:");
  t.after(() => store.close());
  let current = new Date(clock);
  store.upsertSource(integrationSource, current.toISOString());
  const handler = createGateway({ store, primary, paid, token: "gateway-test",
    dailyBudget: budget, now: () => current });
  const request = (path, init = {}) => handler(new Request(`http://gateway.local${path}`, {
    ...init, headers: { authorization: "Bearer gateway-test", ...init.headers },
  }));
  return { store, request, setNow(value) { current = new Date(value); } };
}

test("primary-first gateway caches a seven-day union and never pays on success", async (t) => {
  let paidCalls = 0;
  const { store, request } = gatewayFixture(t, { paid: {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { paidCalls += 1; return { items: [] }; },
  } });
  store.upsertGatewayItems(integrationSource.id, [{ ...paidListItem,
    canonical_id: "wx:MzPaid:2:1", body_text: "对账正文", discovered_at: "2026-08-27T12:00:00.000Z" }]);
  const response = await request(`/v1/feeds/${integrationSource.id}.atom`);
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /loom:provider>primary/);
  assert.match(xml, /自建文章/);
  assert.match(xml, /付费文章/);
  assert.equal(paidCalls, 0);
  assert.equal(store.listGatewayItems(integrationSource.id, "2026-08-21T12:00:00.000Z").length, 2);
});

test("first primary failure is 503 without spend; second uses paid list and only missing-body detail", async (t) => {
  let listCalls = 0;
  const detailed = [];
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { listCalls += 1; return { items: [paidListItem, {
      ...paidListItem, title: "已有正文", original_url: "https://mp.weixin.qq.com/s?__biz=MzPaid&mid=3&idx=1",
    }], cost_money: 0.06 }; },
    async enrichArticle(item) { detailed.push(item.title); return { ...item,
      body_html: "<p>付费完整正文</p>", cost_money: 0.04 }; },
  };
  const { store, request } = gatewayFixture(t, { primary: async () => { throw new Error("down"); }, paid });
  store.upsertGatewayItems(integrationSource.id, [{ ...paidListItem,
    canonical_id: "wx:MzPaid:3:1", title: "已有正文", body_text: "缓存正文",
    original_url: "https://mp.weixin.qq.com/s?__biz=MzPaid&mid=3&idx=1",
    discovered_at: "2026-08-28T11:01:00.000Z" }]);
  const first = await request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal(first.status, 503);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 0, amount: 0 });
  const second = await request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal(second.status, 200);
  assert.match(await second.text(), /loom:provider>dajiala/);
  assert.equal(listCalls, 1);
  assert.deepEqual(detailed, ["付费文章"]);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 2, amount: 0.10 });
});

test("paid detail failure preserves the list floor and exhausted list budget is 429", async (t) => {
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { return { items: [paidListItem], cost_money: 0.08 }; },
    async enrichArticle() { throw Object.assign(new Error("detail down"), { kind: "technical_error" }); },
  };
  const primary = async () => { throw new Error("down"); };
  const working = gatewayFixture(t, { primary, paid });
  await working.request(`/v1/feeds/${integrationSource.id}.atom`);
  const response = await working.request(`/v1/feeds/${integrationSource.id}.atom`);
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /付费文章/);
  assert.match(xml, /mmbiz\.qpic\.cn\/paid\.jpg/);

  const exhausted = gatewayFixture(t, { primary, paid, budget: { rmb: 0.07, calls: 250 } });
  await exhausted.request(`/v1/feeds/${integrationSource.id}.atom`);
  const blocked = await exhausted.request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { code: "paid_budget_exhausted" });
});

test("reconciliation is time-gated, idempotent, prioritised, and stops at the cap", async (t) => {
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday(source) { return { items: [{ ...paidListItem, account_id: source.account_id,
      account_name: source.name, title: `对账-${source.source_id}` }], cost_money: 0.08 }; },
    async enrichArticle(item) { return { ...item, body_html: "<p>对账正文</p>", cost_money: 0.04 }; },
  };
  const fixture = gatewayFixture(t, { clock: "2026-08-28T15:29:00.000Z", paid,
    budget: { rmb: 0.15, calls: 10 } });
  fixture.store.upsertSource({ ...integrationSource, id: "wx-high", account_id: "gh_high",
    name: "高优先级", priority: "high" }, "2026-08-28T00:00:00.000Z");
  assert.deepEqual(await (await fixture.request("/v1/reconcile", { method: "POST" })).json(), {
    day: "2026-08-28", attempted: 0, succeeded: 0, failed: 0,
    succeeded_source_ids: [], budget_exhausted: false,
  });
  fixture.setNow("2026-08-28T15:30:00.000Z");
  const result = await (await fixture.request("/v1/reconcile", { method: "POST" })).json();
  assert.deepEqual(result.succeeded_source_ids, ["wx-high"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.budget_exhausted, true);
  assert.equal(fixture.store.listGatewayItems("wx-high", "2026-08-21T00:00:00.000Z").length, 1);
  const repeated = await (await fixture.request("/v1/reconcile", { method: "POST" })).json();
  assert.equal(repeated.succeeded, 0);
});

test("same-source concurrency shares work and sequential responses use the durable union", async (t) => {
  let calls = 0;
  let release;
  let items = [primaryItem];
  const primary = async () => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    return items;
  };
  const { request } = gatewayFixture(t, { primary });
  const first = request(`/v1/feeds/${integrationSource.id}.atom`);
  const concurrent = request(`/v1/feeds/${integrationSource.id}.atom`);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, concurrent]);
  assert.equal(calls, 1);
  assert.match(await a.text(), /自建文章/);
  assert.match(await b.text(), /自建文章/);
  items = [];
  const sequential = await request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal(sequential.status, 200);
  assert.match(await sequential.text(), /自建文章/);
});

test("gateway health exposes paid configuration and capped daily usage", async (t) => {
  const { store, request } = gatewayFixture(t, { paid: {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045, listToday: async () => ({ items: [] }),
  } });
  const id = store.tryReserveSpend("2026-08-28", "dajiala", 0.08, 20, 250);
  store.adjustSpend(id, 0.06);
  const response = await request(`/v1/sources/${integrationSource.id}/health`);
  assert.deepEqual(await response.json(), {
    source_id: integrationSource.id, alert_state: "normal", last_primary_ok_at: null,
    consecutive_primary_failures: 0, last_paid_check_at: null, last_paid_result: "",
    next_retry_at: null, paid_configured: true, paid_day_amount: 0.06,
    paid_daily_budget: 20, paid_day_calls: 1, paid_daily_call_limit: 250,
  });
});

test("health projects unresolved paid hard errors until a later primary success", async (t) => {
  const fixture = gatewayFixture(t, { clock: "2026-08-28T12:10:00.000Z" });
  const path = `/v1/sources/${integrationSource.id}/health`;
  fixture.store.recordPaidResult(integrationSource.id, "mapping_error", null, "alert",
    "2026-08-28T12:01:00.000Z");
  assert.equal((await (await fixture.request(path)).json()).alert_state, "alert");
  fixture.store.recordPrimarySuccess(integrationSource.id, "2026-08-28T12:01:00.000Z");
  assert.equal((await (await fixture.request(path)).json()).alert_state, "normal");

  fixture.store.recordPaidResult(integrationSource.id, "technical_error", "2026-08-28T12:10:00.000Z",
    "degraded", "2026-08-28T12:05:00.000Z");
  assert.equal((await (await fixture.request(path)).json()).alert_state, "degraded");
  fixture.store.recordPrimarySuccess(integrationSource.id, "2026-08-28T12:06:00.000Z");
  assert.equal((await (await fixture.request(path)).json()).alert_state, "normal");
});

test("health keeps a 24-hour alert above a newer unresolved technical error", async (t) => {
  const fixture = gatewayFixture(t, { clock: "2026-08-28T12:10:00.000Z" });
  const stale = { ...integrationSource, id: "wx-stale" };
  fixture.store.upsertSource(stale, "2026-08-26T12:00:00.000Z");
  fixture.store.recordPaidResult(stale.id, "technical_error", "2026-08-28T12:15:00.000Z",
    "degraded", "2026-08-28T12:10:00.000Z");
  const health = await fixture.request(`/v1/sources/${stale.id}/health`);
  assert.equal((await health.json()).alert_state, "alert");
});

test("health ignores future paid hard errors when projecting the current state", async (t) => {
  for (const result of ["mapping_error", "technical_error"]) {
    const fixture = gatewayFixture(t, { clock: "2026-08-28T12:00:00.000Z" });
    fixture.store.recordPaidResult(integrationSource.id, result,
      result === "technical_error" ? "2026-08-29T12:05:00.000Z" : null,
      result === "mapping_error" ? "alert" : "degraded", "2026-08-29T12:00:00.000Z");
    const health = await fixture.request(`/v1/sources/${integrationSource.id}/health`);
    assert.equal((await health.json()).alert_state, "normal");
  }
});

test("does not detail-enrich an article already known to the normalized cache", async (t) => {
  let detailCalls = 0;
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { return { items: [paidListItem], cost_money: 0.06 }; },
    async enrichArticle(item) { detailCalls += 1; return { ...item, body_html: "正文", cost_money: 0.04 }; },
  };
  const { store, request } = gatewayFixture(t, { primary: async () => { throw new Error("down"); }, paid });
  store.upsertGatewayItems(integrationSource.id, [{ ...paidListItem,
    canonical_id: "wx:MzPaid:2:1", body_text: "", discovered_at: "2026-08-28T11:01:00.000Z" }]);
  await request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal((await request(`/v1/feeds/${integrationSource.id}.atom`)).status, 200);
  assert.equal(detailCalls, 0);
});

test("paid technical failures advance through the 5 then 15 minute retry schedule", async (t) => {
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { throw Object.assign(new Error("temporary"), { kind: "technical_error" }); },
  };
  const fixture = gatewayFixture(t, { clock: "2026-08-28T15:30:00.000Z", paid });
  const first = await (await fixture.request("/v1/reconcile", { method: "POST" })).json();
  assert.equal(first.failed, 1);
  assert.equal(fixture.store.getSource(integrationSource.id).next_retry_at, "2026-08-28T15:35:00.000Z");
  fixture.setNow("2026-08-28T15:35:00.000Z");
  const second = await (await fixture.request("/v1/reconcile", { method: "POST" })).json();
  assert.equal(second.failed, 1);
  assert.equal(fixture.store.getSource(integrationSource.id).next_retry_at, "2026-08-28T15:50:00.000Z");
});

test("a successful source request removes cached articles older than 30 days", async (t) => {
  const { store, request } = gatewayFixture(t);
  store.upsertGatewayItems(integrationSource.id, [{ ...paidListItem,
    canonical_id: "wx:old:1:1", published_at: "2026-07-20T10:00:00.000Z",
    discovered_at: "2026-07-20T10:01:00.000Z" }]);
  assert.equal((await request(`/v1/feeds/${integrationSource.id}.atom`)).status, 200);
  assert.deepEqual(store.listGatewayItems(integrationSource.id, "2020-01-01T00:00:00.000Z")
    .map(({ canonical_id }) => canonical_id), [primaryItem.canonical_id]);
});

test("concurrent reconciliations serialize per source and the waiter skips a completed success", async (t) => {
  let listCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() {
      listCalls += 1;
      await gate;
      return { items: [], cost_money: 0.06 };
    },
  };
  const fixture = gatewayFixture(t, { clock: "2026-08-28T15:30:00.000Z", paid });
  const first = fixture.request("/v1/reconcile", { method: "POST" });
  const second = fixture.request("/v1/reconcile", { method: "POST" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second].map(async (response) => (await response).json()));
  assert.equal(listCalls, 1);
  assert.deepEqual(results.map(({ succeeded }) => succeeded).sort(), [0, 1]);
  assert.deepEqual(results.map(({ attempted }) => attempted).sort(), [0, 1]);
  assert.deepEqual(fixture.store.getProviderUsage("2026-08-28", "dajiala"), { calls: 1, amount: 0.06 });
});

test("feed waiting behind reconciliation reuses the paid cache instead of spending twice", async (t) => {
  let listCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() {
      listCalls += 1;
      await gate;
      return { items: [], cost_money: 0.06 };
    },
  };
  const fixture = gatewayFixture(t, { clock: "2026-08-28T15:30:00.000Z",
    primary: async () => { throw new Error("down"); }, paid });
  fixture.store.recordPrimaryFailure(integrationSource.id, "2026-08-28T15:20:00.000Z");
  const reconciliation = fixture.request("/v1/reconcile", { method: "POST" });
  const feed = fixture.request(`/v1/feeds/${integrationSource.id}.atom`);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await reconciliation).status, 200);
  assert.equal((await feed).status, 200);
  assert.equal(listCalls, 1);
  assert.deepEqual(fixture.store.getProviderUsage("2026-08-28", "dajiala"), { calls: 1, amount: 0.06 });
});

test("reconciliation isolates an invalid source and continues to the next source", async (t) => {
  const paid = {
    estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday(source) { return { items: [{ ...paidListItem, account_id: source.account_id,
      account_name: source.name, original_url: source.source_id === "wx-bad"
        ? "https://example.com/unsafe" : paidListItem.original_url }], cost_money: 0.06 }; },
  };
  const fixture = gatewayFixture(t, { clock: "2026-08-28T15:30:00.000Z", paid });
  fixture.store.upsertSource({ ...integrationSource, id: "wx-bad", priority: "high",
    account_id: "gh_bad" }, "2026-08-28T00:00:00.000Z");
  const response = await fixture.request("/v1/reconcile", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { day: "2026-08-28", attempted: 2, succeeded: 1,
    failed: 1, succeeded_source_ids: [integrationSource.id], budget_exhausted: false });
});

test("reconciliation crossing Shanghai midnight bills the old day, skips details, and stops", async (t) => {
  let current = new Date("2026-08-28T15:59:59.000Z");
  let detailCalls = 0;
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertSource({ ...integrationSource, priority: "high" }, "2026-08-28T00:00:00.000Z");
  store.upsertSource({ ...integrationSource, id: "wx-later", account_id: "gh_later" },
    "2026-08-28T00:00:00.000Z");
  const paid = { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday(source) {
      current = new Date("2026-08-28T16:00:01.000Z");
      return { items: [{ ...paidListItem, account_id: source.account_id, account_name: source.name }],
        cost_money: 0.06 };
    },
    async enrichArticle(item) { detailCalls += 1; return { ...item, body_html: "正文", cost_money: 0.04 }; },
  };
  const gateway = createGateway({ store, primary: async () => [], paid, token: "gateway-test",
    now: () => current });
  const response = await gateway(new Request("http://gateway.local/v1/reconcile", {
    method: "POST", headers: { authorization: "Bearer gateway-test" },
  }));
  const result = await response.json();
  assert.equal(result.day, "2026-08-28");
  assert.equal(result.attempted, 1);
  assert.equal(detailCalls, 0);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 1, amount: 0.06 });
  assert.deepEqual(store.getProviderUsage("2026-08-29", "dajiala"), { calls: 0, amount: 0 });
  assert.equal(store.getSource(integrationSource.id).last_paid_check_at, "2026-08-28T16:00:01.000Z");
  assert.equal(store.getSource(integrationSource.id).last_paid_ok_at, "2026-08-28T15:59:59.000Z");
  assert.equal(store.listGatewayItems(integrationSource.id, "2026-08-20T00:00:00.000Z")[0].discovered_at,
    "2026-08-28T16:00:01.000Z");
});

test("a paid call begun before midnight remains eligible on the next Shanghai day", async (t) => {
  let current = new Date("2026-08-28T15:59:59.000Z");
  let calls = 0;
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertSource(integrationSource, "2026-08-28T00:00:00.000Z");
  const gateway = createGateway({ store, token: "gateway-test", now: () => current,
    primary: async () => [], paid: { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
      async listToday() {
        calls += 1;
        if (calls === 1) current = new Date("2026-08-28T16:00:01.000Z");
        return { items: [], cost_money: 0.06 };
      } } });
  const request = () => gateway(new Request("http://gateway.local/v1/reconcile", {
    method: "POST", headers: { authorization: "Bearer gateway-test" },
  }));
  assert.equal((await request()).status, 200);
  current = new Date("2026-08-29T15:35:00.000Z");
  assert.equal((await request()).status, 200);
  assert.equal(calls, 2);
});

test("reconciliation crossing midnight after the lock check makes no paid call", async (t) => {
  const moments = [
    new Date("2026-08-28T15:59:59.000Z"),
    new Date("2026-08-28T15:59:59.500Z"),
    new Date("2026-08-28T16:00:00.000Z"),
  ];
  let clockReads = 0;
  let calls = 0;
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertSource(integrationSource, "2026-08-28T00:00:00.000Z");
  const gateway = createGateway({ store, token: "gateway-test", primary: async () => [],
    now: () => moments[Math.min(clockReads++, moments.length - 1)],
    paid: { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
      async listToday() { calls += 1; return { items: [], cost_money: 0.06 }; } } });
  const result = await (await gateway(new Request("http://gateway.local/v1/reconcile", {
    method: "POST", headers: { authorization: "Bearer gateway-test" },
  }))).json();
  assert.equal(result.attempted, 0);
  assert.equal(calls, 0);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 0, amount: 0 });
  assert.deepEqual(store.getProviderUsage("2026-08-29", "dajiala"), { calls: 0, amount: 0 });
});

test("feed fallback reserves on the clock at the paid call, not request entry", async (t) => {
  let current = new Date("2026-08-28T15:59:59.000Z");
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertSource(integrationSource, "2026-08-28T00:00:00.000Z");
  store.recordPrimaryFailure(integrationSource.id, "2026-08-28T15:50:00.000Z");
  const gateway = createGateway({ store, token: "gateway-test", now: () => current,
    primary: async () => { current = new Date("2026-08-28T16:00:01.000Z"); throw new Error("down"); },
    paid: { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
      async listToday() { return { items: [], cost_money: 0.06 }; } } });
  assert.equal((await gateway(new Request(`http://gateway.local/v1/feeds/${integrationSource.id}.atom`, {
    headers: { authorization: "Bearer gateway-test" },
  }))).status, 200);
  assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), { calls: 0, amount: 0 });
  assert.deepEqual(store.getProviderUsage("2026-08-29", "dajiala"), { calls: 1, amount: 0.06 });
});

test("reconciliation reports exact call-cap and provider overrun exhaustion", async (t) => {
  for (const [budget, actual] of [[{ rmb: 20, calls: 1 }, 0.06], [{ rmb: 0.08, calls: 10 }, 0.09]]) {
    const fixture = gatewayFixture(t, { clock: "2026-08-28T15:30:00.000Z", budget,
      paid: { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
        async listToday() { return { items: [], cost_money: actual }; } } });
    const result = await (await fixture.request("/v1/reconcile", { method: "POST" })).json();
    assert.equal(result.succeeded, 1);
    assert.equal(result.budget_exhausted, true);
  }
});

test("duplicate paid list items buy detail once after canonical de-duplication", async (t) => {
  let details = 0;
  const paid = { estimatedListCost: 0.08, estimatedDetailCost: 0.045,
    async listToday() { return { items: [paidListItem, { ...paidListItem }], cost_money: 0.06 }; },
    async enrichArticle(item) { details += 1; return { ...item, body_html: "正文", cost_money: 0.04 }; },
  };
  const fixture = gatewayFixture(t, { primary: async () => { throw new Error("down"); }, paid });
  await fixture.request(`/v1/feeds/${integrationSource.id}.atom`);
  assert.equal((await fixture.request(`/v1/feeds/${integrationSource.id}.atom`)).status, 200);
  assert.equal(details, 1);
  assert.deepEqual(fixture.store.getProviderUsage("2026-08-28", "dajiala"), { calls: 2, amount: 0.10 });
});

test("PUT rejects owner changes, serializes with feed, resets repaired mapping, and sanitizes JSON", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = gatewayFixture(t, { primary: async () => { await gate; return [primaryItem]; } });
  fixture.store.upsertGatewayItems(integrationSource.id, [primaryItem]);
  fixture.store.recordPaidResult(integrationSource.id, "mapping_error", null, "alert",
    "2026-08-28T11:00:00.000Z");
  const badJson = await fixture.request(`/v1/sources/${integrationSource.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: '{"secret":"do-not-echo",',
  });
  assert.deepEqual(await badJson.json(), { error: "invalid JSON" });
  const feed = fixture.request(`/v1/feeds/${integrationSource.id}.atom`);
  const update = fixture.request(`/v1/sources/${integrationSource.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...integrationSource, name: "修复后", sample_url: "https://mp.weixin.qq.com/s/repaired",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.store.getSource(integrationSource.id).name, integrationSource.name);
  release();
  assert.equal((await feed).status, 200);
  assert.equal((await update).status, 200);
  assert.equal(fixture.store.getSource(integrationSource.id).last_paid_result, "");

  const owner = await fixture.request(`/v1/sources/${integrationSource.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...integrationSource, account_id: "gh_other",
    }),
  });
  assert.equal(owner.status, 422);
  assert.equal(fixture.store.getSource(integrationSource.id).account_id, integrationSource.account_id);
  assert.equal(fixture.store.listGatewayItems(integrationSource.id, "2026-08-20T00:00:00.000Z").length, 1);
  assert.equal(fixture.store.getSource(integrationSource.id).last_paid_check_at, null);
  assert.equal(fixture.store.getSource(integrationSource.id).next_retry_at, null);
  assert.equal(fixture.store.getSource(integrationSource.id).alert_state, "normal");
  const readable = await fixture.request(`/v1/sources/${integrationSource.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ignored" }),
  });
  assert.match((await readable.json()).error, /name/);
});

test("the Node gateway returns a fixed 413 for a PUT body above one MiB", async (t) => {
  const store = openStore(":memory:");
  const gateway = createGatewayServer({ store, token: "gateway-test",
    allowedFeedHosts: new Set(["feeds.internal"]) }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => { gateway.close(); store.close(); });
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/sources/wx-large`, {
    method: "PUT", headers: { authorization: "Bearer gateway-test", "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request body too large" });
});
