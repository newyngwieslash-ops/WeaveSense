import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFeedXml } from "./rss-parser.ts";

const articleUrl = "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc";
const publishedAt = "2026-08-29T08:00:00.000Z";

function atomEntry(body: string, thumbnail = "https://cdn.example.com/cover.jpg", bodyComplete = true): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:loom="https://loom.example.com/ns">
    <entry>
      <id>wx:MzA1:9:1</id>
      <title>微信长文</title>
      <author><name>公众号作者</name></author>
      <published>${publishedAt}</published>
      <link rel="alternate" href="${articleUrl.replaceAll("&", "&amp;")}" />
      <content type="html"><![CDATA[${body}]]></content>
      ${thumbnail ? `<media:thumbnail url="${thumbnail}" />` : ""}
      <loom:provider>primary</loom:provider>
      <loom:providers_seen>primary,dajiala,primary</loom:providers_seen>
      <loom:discovered_at>2026-08-29T08:05:00.000Z</loom:discovered_at>
      <loom:body_complete>${bodyComplete}</loom:body_complete>
    </entry>
  </feed>`;
}

describe("parseFeedXml", () => {
  it("keeps every entry in a bounded feed", () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      `<item><guid>entry-${i}</guid><link>https://example.com/${i}</link><title>${i}</title></item>`).join("");
    const items = parseFeedXml(`<rss><channel>${entries}</channel></rss>`, "s", "rss");
    assert.equal(items.length, 60);
    assert.equal(items.at(-1)?.external_id, "entry-59");
    assert.throws(() => parseFeedXml("<html><body>login</body></html>", "s", "rss"), /invalid_feed/);
    assert.throws(() => parseFeedXml("<rss><channel>", "s", "rss"), /invalid_feed/);
    assert.deepEqual(parseFeedXml("<rss><channel/></rss>", "s", "rss"), []);
  });

  it("accepts 1000 entries and explicitly rejects feeds above the entry limit", () => {
    const entry = "<item><guid>entry</guid><link>https://example.com/entry</link><title>entry</title></item>";
    assert.equal(parseFeedXml(`<rss><channel>${entry.repeat(1000)}</channel></rss>`, "s", "rss").length, 1000);
    assert.throws(() => parseFeedXml(`<rss><channel>${entry.repeat(1001)}</channel></rss>`, "s", "rss"),
      /feed_entry_limit/);
  });

  it("keeps WeChat Atom article metadata and its complete body", () => {
    const body = "正文".repeat(5000);
    const [item] = parseFeedXml(atomEntry(body), "source-1", "wechat");

    assert.equal(item.external_id, "wx:MzA1:9:1");
    assert.equal(item.body.length, body.length);
    assert.equal(item.author, "公众号作者");
    assert.equal(item.thumbnail_url, "https://cdn.example.com/cover.jpg");
    assert.deepEqual(item.extra, {
      platform: "wechat",
      provider: "primary",
      providers_seen: ["primary", "dajiala"],
      discovered_at: "2026-08-29T08:05:00.000Z",
      body_complete: true,
    });
  });

  it("keeps metadata but clears a body whose UTF-8 payload exceeds 2 MiB", () => {
    const body = "文".repeat(Math.ceil((2 * 1024 * 1024 + 1) / Buffer.byteLength("文", "utf8")));
    const [item] = parseFeedXml(atomEntry(body), "source-1", "wechat");

    assert.equal(item.external_id, "wx:MzA1:9:1");
    assert.equal(item.title, "微信长文");
    assert.equal(item.author, "公众号作者");
    assert.equal(item.url, articleUrl);
    assert.equal(item.published_at, publishedAt);
    assert.equal(item.thumbnail_url, "https://cdn.example.com/cover.jpg");
    assert.equal(item.body, "");
    assert.deepEqual(item.extra, {
      platform: "wechat",
      provider: "primary",
      providers_seen: ["primary", "dajiala"],
      discovered_at: "2026-08-29T08:05:00.000Z",
      body_complete: false,
      body_error: "body_too_large",
    });
  });

  it("retains required metadata when an Atom article has no body or thumbnail", () => {
    const [item] = parseFeedXml(atomEntry("", "", false), "source-1", "wechat");

    assert.equal(item.external_id, "wx:MzA1:9:1");
    assert.equal(item.title, "微信长文");
    assert.equal(item.author, "公众号作者");
    assert.equal(item.url, articleUrl);
    assert.equal(item.published_at, publishedAt);
    assert.equal(item.body, "");
    assert.equal(item.thumbnail_url, "");
    assert.equal(item.extra.body_complete, false);
  });

  // T11 changed this expectation deliberately, and the change is a product fix
  // rather than a test being bent to fit: the old 8,000-character cut applied to
  // non-WeChat feeds destroyed the tail of long articles at ingestion, so the
  // material could never be searched or quoted afterwards. The storage layer now
  // keeps the body; the model context budget (agent-context) is where a limit
  // belongs. See src/lib/server/content-integrity.test.ts for the tail assertion
  // this used to make impossible.
  it("keeps a long non-WeChat body in full (no 8,000-character ingestion cut)", () => {
    const body = "正文".repeat(5000);
    const [item] = parseFeedXml(atomEntry(body), "source-1", "rss");

    assert.equal(item.body.length, body.length);
    assert.equal(item.extra.body_error, undefined);
    assert.equal(item.extra.body_complete, true);
  });

  it("uses the first non-empty name from repeated Atom authors", () => {
    const xml = atomEntry("正文").replace(
      "<author><name>公众号作者</name></author>",
      "<author><name></name></author><author><name>首位作者</name></author><author><name>后续作者</name></author>",
    );
    const [item] = parseFeedXml(xml, "source-1", "wechat");

    assert.equal(item.author, "首位作者");
  });
});
