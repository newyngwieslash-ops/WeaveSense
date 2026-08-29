import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFeedXml } from "./rss-parser.ts";

const articleUrl = "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc";
const publishedAt = "2026-08-29T08:00:00.000Z";

function atomEntry(body: string, thumbnail = "https://cdn.example.com/cover.jpg"): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:loom="https://loom.example.com/ns">
    <entry>
      <id>wx:MzA1:9:1</id>
      <title>微信长文</title>
      <author><name>公众号作者</name></author>
      <published>${publishedAt}</published>
      <link rel="alternate" href="${articleUrl}" />
      <content type="html"><![CDATA[${body}]]></content>
      ${thumbnail ? `<media:thumbnail url="${thumbnail}" />` : ""}
      <loom:provider>primary</loom:provider>
      <loom:discovered_at>2026-08-29T08:05:00.000Z</loom:discovered_at>
    </entry>
  </feed>`;
}

describe("parseFeedXml", () => {
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
      discovered_at: "2026-08-29T08:05:00.000Z",
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
      discovered_at: "2026-08-29T08:05:00.000Z",
      body_error: "body_too_large",
    });
  });

  it("retains required metadata when an Atom article has no body or thumbnail", () => {
    const [item] = parseFeedXml(atomEntry("", ""), "source-1", "wechat");

    assert.equal(item.external_id, "wx:MzA1:9:1");
    assert.equal(item.title, "微信长文");
    assert.equal(item.author, "公众号作者");
    assert.equal(item.url, articleUrl);
    assert.equal(item.published_at, publishedAt);
    assert.equal(item.body, "");
    assert.equal(item.thumbnail_url, "");
  });
});
