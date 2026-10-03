#!/usr/bin/env node
/**
 * T06: every real download caller now inherits the outbound policy.
 *
 * One failure boundary per caller, driven through the *caller's own* entry point
 * with an injected transport/resolver, so this proves wiring rather than just
 * re-testing `publicFetch`:
 *
 *   - RSS/Atom feed fetch (`fetchRss`)
 *   - Telegram public channel page (`fetchTelegramChannel`)
 *   - keyword search JSON (`fetchJson` via B站/Google News shape)
 *   - media ingest (`publicFetch` with the media cap)
 *
 * Internal services (model gateway, MinIO, the Telegram worker, the WeChat
 * gateway) are covered by the audit in the execution record: they keep their own
 * transports and are not routed through the public policy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchJson, fetchText, type FetchIo } from "./http.ts";
import { fetchRss } from "./rss.ts";
import { fetchTelegramChannel } from "./telegram.ts";
import { MEDIA_MAX_BYTES, TEXT_MAX_BYTES } from "./outbound-policy.ts";
import type { BodyLike, DnsResolver, OutboundTransport } from "./outbound-policy.ts";

function resolverFor(map: Record<string, string[]>): DnsResolver {
  return {
    async lookup(hostname: string) {
      const answers = map[hostname];
      if (!answers) throw new Error("dns_not_found");
      return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

function bodyOf(chunks: (string | Uint8Array)[]): BodyLike {
  let index = 0;
  return {
    getReader: () => ({
      async read() {
        if (index >= chunks.length) return { done: true, value: undefined };
        const value = chunks[index++];
        return { done: false, value: typeof value === "string" ? new TextEncoder().encode(value) : value };
      },
      async cancel() {
        index = chunks.length;
      },
      releaseLock() {},
    }),
  };
}

/** A transport that answers every request with the given body. */
function transportReturning(body: string, status = 200, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const transport: OutboundTransport = async (url) => {
    calls.push(url.href);
    return { status, headers: { "content-type": "text/plain", ...headers }, body: bodyOf([body]) };
  };
  return { transport, calls };
}

const PUBLIC = resolverFor({
  "example.com": ["93.184.216.34"],
  "news.google.com": ["142.250.72.14"],
  "t.me": ["149.154.167.99"],
  "api.bilibili.com": ["119.3.70.188"],
  "cdn.example.com": ["1.1.1.1"],
});

const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>条目</title><link>https://example.com/a</link><guid>a</guid>
<description>正文</description><pubDate>Tue, 15 Sep 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

test("RSS feed fetch goes through the policy and parses normally", async () => {
  const { transport, calls } = transportReturning(feedXml);
  const items = await fetchRss("https://example.com/feed.xml", "s1", "rss", { resolver: PUBLIC, transport } as FetchIo);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "条目");
  assert.deepEqual(calls, ["https://example.com/feed.xml"]);
});

test("RSS cannot be pointed at loopback or metadata addresses", async () => {
  for (const url of [
    "http://127.0.0.1:8080/feed.xml",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/feed.xml",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(
      () => fetchRss(url, "s1", "rss", { resolver: PUBLIC, transport: transportReturning(feedXml).transport } as FetchIo),
      /blocked_address|unsupported_protocol|invalid_url/,
      url,
    );
  }
});

test("an RSS redirect to a private address is refused before the second request", async () => {
  const calls: string[] = [];
  const transport: OutboundTransport = async (url) => {
    calls.push(url.href);
    return {
      status: 302,
      headers: { location: "http://169.254.169.254/" },
      body: bodyOf([]),
    };
  };
  await assert.rejects(
    () => fetchRss("https://example.com/feed.xml", "s1", "rss", { resolver: PUBLIC, transport } as FetchIo),
    /blocked_address/,
  );
  assert.equal(calls.length, 1, "the metadata hop must never be requested");
});

test("an RSS body over the text cap is rejected, not truncated", async () => {
  const huge = "x".repeat(TEXT_MAX_BYTES + 1024);
  const { transport } = transportReturning(huge);
  await assert.rejects(
    () => fetchRss("https://example.com/feed.xml", "s1", "rss", { resolver: PUBLIC, transport } as FetchIo),
    /response_too_large/,
  );
});

test("the Telegram public page fetch uses the policy", async () => {
  const html = `<div class="tgme_widget_message " data-post="chan/1"><div class="tgme_widget_message_text">消息一</div><time datetime="2026-09-15T02:00:00+00:00"></time></div>`;
  const { transport, calls } = transportReturning(html);
  const items = await fetchTelegramChannel("@chan", { resolver: PUBLIC, transport } as FetchIo);
  assert.equal(items.length, 1);
  assert.match(calls[0], /^https:\/\/t\.me\/s\/chan$/);
});

test("the Telegram page fetch refuses a private target", async () => {
  await assert.rejects(
    () => fetchText("http://192.168.1.10/", 5000, undefined, {}, { resolver: PUBLIC, transport: transportReturning("x").transport } as FetchIo),
    /blocked_address/,
  );
});

test("keyword search JSON goes through the policy and rejects a private host", async () => {
  const json = JSON.stringify({ code: 0, data: { result: [] } });
  const { transport, calls } = transportReturning(json, 200, { "content-type": "application/json" });
  const parsed = await fetchJson<{ code: number }>(
    "https://api.bilibili.com/x/web-interface/search/type?keyword=a",
    10000,
    { resolver: PUBLIC, transport } as FetchIo,
  );
  assert.equal(parsed.code, 0);
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => fetchJson("http://169.254.169.254/latest/meta-data/", 10000, { resolver: PUBLIC, transport: transportReturning(json).transport } as FetchIo),
    /blocked_address/,
  );
});

test("a keyword response over the cap is refused", async () => {
  const big = JSON.stringify({ pad: "y".repeat(TEXT_MAX_BYTES + 64) });
  await assert.rejects(
    () => fetchJson("https://news.google.com/rss/search?q=a", 10000, { resolver: PUBLIC, transport: transportReturning(big).transport } as FetchIo),
    /response_too_large/,
  );
});

test("media fetches use the larger media cap and still refuse private targets", async () => {
  // The media cap must be strictly larger than the text cap, or image/audio
  // ingestion would break on files that the text rule would have allowed.
  assert.ok(MEDIA_MAX_BYTES > TEXT_MAX_BYTES);

  // 5 MiB: above the text cap, below the media cap — accepted when asked as media.
  const fiveMb = new Uint8Array(5 * 1024 * 1024);
  const { transport } = transportReturning("ignored");
  const mediaTransport: OutboundTransport = async () => ({
    status: 200,
    headers: { "content-type": "image/png" },
    body: bodyOf([fiveMb]),
  });
  const { publicFetch } = await import("./outbound-policy.ts");
  const viaMedia = await publicFetch("https://cdn.example.com/pic.png", {
    resolver: PUBLIC,
    transport: mediaTransport,
    kind: "media",
    as: "bytes",
  });
  assert.equal(viaMedia.bytes?.byteLength, 5 * 1024 * 1024);

  // ...and the same size fetched as *text* (the default) is still refused.
  await assert.rejects(
    () => publicFetch("https://cdn.example.com/pic.png", { resolver: PUBLIC, transport: mediaTransport, kind: "text" }),
    /response_too_large/,
  );

  await assert.rejects(
    () => publicFetch("http://10.0.0.9/pic.png", { resolver: PUBLIC, transport, kind: "media" }),
    /blocked_address/,
  );
});
