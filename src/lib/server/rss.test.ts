import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFeedXml } from "./rss-parser.ts";
import { fetchRss } from "./rss.ts";

const articleUrl = "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc";
const publishedAt = "2026-08-29T08:00:00.000Z";

function atomEntry(body: string, thumbnail = "https://cdn.example.com/cover.jpg", bodyComplete = true): string {
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
      <loom:providers_seen>primary,dajiala,primary</loom:providers_seen>
      <loom:discovered_at>2026-08-29T08:05:00.000Z</loom:discovered_at>
      <loom:body_complete>${bodyComplete}</loom:body_complete>
    </entry>
  </feed>`;
}

describe("parseFeedXml", () => {
  it("preserves 100 entries and fails explicitly above 1000", () => {
    const feed = (count: number) => '<rss><channel>' + Array.from({ length: count }, (_, i) =>
      `<item><guid>${i}</guid><title>article ${i}</title></item>`).join('') + '</channel></rss>';
    assert.equal(parseFeedXml(feed(100), "s", "rss").length, 100);
    assert.equal(parseFeedXml(feed(1000), "s", "rss").length, 1000);
    assert.throws(() => parseFeedXml(feed(1001), "s", "rss"), { message: "feed_entry_limit" });
  });

  it("rejects non-feeds and malformed XML but accepts empty RSS, Atom and RDF", () => {
    assert.throws(() => parseFeedXml('<html><body>verify</body></html>', "s", "rss"), { message: "feed_unknown_root" });
    assert.throws(() => parseFeedXml('<rss><channel></rss>', "s", "rss"), { message: "feed_invalid_xml" });
    for (const xml of ['<feed/><html/>', '<feed/><feed/>', '<rss/>', '<rss><channel/><channel/></rss>']) {
      assert.throws(() => parseFeedXml(xml, "s", "rss"), { message: "feed_invalid_xml" });
    }
    for (const xml of ['<rss><channel></channel></rss>', '<feed/>', '<rdf:RDF/>']) {
      assert.deepEqual(parseFeedXml(xml, "s", "rss"), []);
    }
  });

  it("isolates bad entries with a count and fails when all entries are bad", () => {
    const stats = { rejected_entries: 0 };
    const xml = '<rss><channel><item/><item>bad</item><item><title>bad date</title><pubDate>invalid</pubDate></item><item><guid>0</guid><title>valid</title></item></channel></rss>';
    const items = parseFeedXml(xml, "s", "rss", { stats });
    assert.deepEqual(items.map((item) => item.external_id), ['0']);
    assert.equal(stats.rejected_entries, 3);
    assert.throws(() => parseFeedXml('<feed><entry/></feed>', "s", "rss", { stats }), { message: "feed_no_usable_entries" });
    assert.equal(stats.rejected_entries, 1);
  });

  it("rejects overlong identities instead of accepting colliding truncated keys", () => {
    const prefix = "g".repeat(320);
    const stats = { rejected_entries: 0 };
    const entries = `<item><guid>${prefix}a</guid><title>first</title></item><item><guid>${prefix}b</guid><title>second</title></item>`;
    assert.throws(() => parseFeedXml(`<rss><channel>${entries}</channel></rss>`, "s", "rss", { stats }), { message: "feed_no_usable_entries" });
    assert.equal(stats.rejected_entries, 2);
    const accepted = parseFeedXml(`<rss><channel>${entries}<item><guid>${prefix}</guid><title>supported</title></item></channel></rss>`, "s", "rss", { stats });
    assert.deepEqual(accepted.map((item) => item.external_id), [prefix]);
    assert.equal(stats.rejected_entries, 2);
  });

  it("keeps URNs as IDs, resolves relative URLs and labels audio enclosures", () => {
    const [item, urnOnly] = parseFeedXml('<feed><entry><id>urn:audio:1</id><title>episode</title><link rel="alternate" href="../episodes/1"/><link rel="enclosure" type="audio/mpeg" href="./1.mp3"/></entry><entry><id>urn:article:2</id><title>no link</title></entry></feed>', "s", "rss", { feedUrl: "https://feed.example/sub/feed.xml" });
    assert.equal(item.external_id, 'urn:audio:1');
    assert.equal(item.url, 'https://feed.example/episodes/1');
    assert.equal(item.media_type, 'audio');
    assert.deepEqual(item.media_urls, ['https://feed.example/sub/1.mp3']);
    assert.equal(urnOnly.url, '');
    assert.equal(urnOnly.external_id, 'urn:article:2');
    const [rssAudio] = parseFeedXml('<rss><channel><item><guid isPermaLink="false">urn:podcast:3</guid><title>podcast</title><enclosure type="audio/ogg" url="https://feed.example/3.ogg"/></item></channel></rss>', "s", "rss");
    assert.equal(rssAudio.media_type, 'audio');
    assert.equal(rssAudio.url, '');
  });

  it("fetchRss resolves links using the final redirect URL", async () => {
    const items = await fetchRss('https://feed.example/start', 's', 'rss', {
      resolver: { async lookup() { return [{ address: '1.1.1.1', family: 4 }]; } },
      transport: async (url) => url.pathname === '/start'
        ? { status: 302, headers: { location: '/nested/feed.xml' }, body: new Response('').body! }
        : { status: 200, headers: {}, body: new Response('<rss><channel><item><title>relative</title><link>article</link></item></channel></rss>').body! },
    });
    assert.equal(items[0].url, 'https://feed.example/nested/article');
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
