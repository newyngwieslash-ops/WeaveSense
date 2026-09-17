import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseFeedXml } from "./rss-parser.ts";

/**
 * T11: the *stored* body must keep its tail — truncation belongs to the model
 * context budget, not to ingestion.
 *
 * The defect: `scheduler.ts` and `rss-parser.ts` sliced non-WeChat bodies to
 * 8,000 characters. A 12,500-character article therefore lost everything past
 * 8,000 permanently at the storage layer, and the existing "long content" Q&A
 * fixture could not have caught it: it asserts against a body that was already
 * truncated. The plan's marker string makes the loss explicit and greppable.
 */
const TAIL_MARKER = "TAIL-READINESS-12500";

/** The long body itself: 12,500+ characters, ending in the unique marker. */
function longBody(): string {
  const prefix = "正文段落。".repeat(1100); // 5,500 chars
  const filler = "补充说明。".repeat(1400); // 7,000 chars
  return `${prefix}${filler}${TAIL_MARKER}`;
}

/** A feed whose single item carries that body. */
function longFeedXml(): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>长正文</title><link>https://example.com/long</link><guid>long</guid>
<description><![CDATA[${longBody()}]]></description>
<pubDate>Tue, 15 Sep 2026 02:00:00 GMT</pubDate></item></channel></rss>`;
}

test("the fixture body is long enough to exceed the old 8,000-char cut", () => {
  const body = longBody();
  assert.ok(body.length > 12_000, `fixture must exceed 12,000 chars, got ${body.length}`);
  assert.equal(body.match(/TAIL-READINESS-12500/g)?.length, 1, "the marker must be unique");
});

test("a non-WeChat feed keeps the tail through parsing", () => {
  const items = parseFeedXml(longFeedXml(), "src-1", "rss");
  assert.equal(items.length, 1);
  const body = items[0].body;
  assert.ok(body.length > 8_000, `stored body was cut at ${body.length} chars`);
  assert.ok(body.endsWith(TAIL_MARKER), "the tail marker must survive parsing");
  assert.ok(body.includes(TAIL_MARKER), "and be findable by search");
});

test("a WeChat feed keeps its tail too", () => {
  const items = parseFeedXml(longFeedXml(), "src-1", "wechat");
  assert.ok(items[0].body.endsWith(TAIL_MARKER));
});

test("the item row itself must not be the place a body is cut", async () => {
  // The scheduler's insert path slices before writing; this asserts the contract
  // the fix has to satisfy — a 12,500-char body survives a round trip through a
  // table with a plain text column.
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table items (id text primary key, body text not null default '')`);
  const body = longBody();
  await pg.query("insert into items (id, body) values ($1, $2)", ["long", body]);
  const { rows } = await pg.query<{ body: string }>("select body from items where id = 'long'");
  assert.equal(rows[0].body.length, body.length);
  assert.ok(rows[0].body.endsWith(TAIL_MARKER));
  await pg.close();
});
