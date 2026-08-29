import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { toAtom } from "./atom.mjs";
import { canonicalWechatId, fetchPrimary } from "./primary.mjs";
import { authorize, createGatewayServer, validateSourceInput } from "./server.mjs";
import { openStore } from "./store.mjs";

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
  }).id, "wx-1");
  assert.throws(() => validateSourceInput({ id: "wx-1", name: "示例号" }), /sample_url/);
});

test("stores source health state in SQLite", () => {
  const store = openStore(":memory:");
  const source = validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example", priority: "high",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  });
  store.upsertSource(source, "2026-08-28T00:00:00.000Z");
  store.recordPrimaryFailure("wx-1", "2026-08-28T01:00:00.000Z");
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 1);
  store.recordPrimarySuccess("wx-1", "2026-08-28T02:00:00.000Z");
  assert.equal(store.getSource("wx-1").last_primary_ok_at, "2026-08-28T02:00:00.000Z");
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 0);
  assert.equal(store.listSources().length, 1);
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
  }, new Date("2026-08-28T09:00:00Z"));
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
  }), /invalid primary entry/);
});

test("serializes the required XML-safe Atom contract", () => {
  const xml = toAtom("wx-1", "示例<&号", [{
    canonical_id: "wx:MzA1:9:1", account_id: "gh_example", account_name: "示例号",
    title: "标题 <&", published_at: "2026-08-28T08:00:00+08:00",
    original_url: "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc",
    body_text: "正文 ]]> 尾", cover_url: "https://mmbiz.qpic.cn/cover.jpg?a=1&b=2",
    provider: "primary", discovered_at: "2026-08-28T09:00:00Z",
  }]);
  assert.match(xml, /wx:MzA1:9:1/);
  assert.match(xml, /loom:provider>primary/);
  assert.match(xml, /media:thumbnail/);
  assert.match(xml, /]]]]><!\[CDATA\[>/);
  assert.doesNotThrow(() => new XMLParser().parse(xml));
});

test("serves authenticated source, health, and feed routes", async (t) => {
  const upstream = createServer((_req, res) => res.end(`
    <feed xmlns="http://www.w3.org/2005/Atom"><entry><title>标题</title>
    <published>2026-08-28T08:00:00+08:00</published>
    <link href="https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=9&amp;idx=1&amp;sn=abc"/></entry></feed>`)).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const store = openStore(":memory:");
  const gateway = createGatewayServer({ store, token: "gateway-test" }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => { upstream.close(); gateway.close(); });
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
  assert.equal((await fetch(`${base}/v1/sources/wx-1/health`, { headers })).status, 200);
  const feed = await fetch(`${base}/v1/feeds/wx-1.atom`, { headers });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type"), /application\/atom\+xml/);
  assert.match(await feed.text(), /<entry>/);
  assert.equal(store.getSource("wx-1").consecutive_primary_failures, 0);
});
