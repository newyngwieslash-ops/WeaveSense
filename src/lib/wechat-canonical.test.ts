import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWechatId,
  normalizeWechatUrl,
  wechatSourceId,
} from "./wechat-canonical.ts";

describe("wechatSourceId", () => {
  it("creates the same safe source id for the same normalized WeChat id", () => {
    assert.equal(wechatSourceId("gh_example"), wechatSourceId(" GH_EXAMPLE "));
    assert.match(wechatSourceId("gh_example"), /^wx-[a-f0-9]{20}$/);
  });

  it("rejects an empty WeChat id", () => {
    assert.throws(() => wechatSourceId("  "), /wechat_id/);
  });
});

describe("normalizeWechatUrl", () => {
  it("strips tracking parameters and hash while keeping content parameters sorted", () => {
    const normalized = normalizeWechatUrl(
      "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc&scene=21#wechat_redirect",
    );

    assert.equal(
      normalized,
      "https://mp.weixin.qq.com/s?__biz=MzA1&idx=1&mid=9&sn=abc",
    );
  });

  it("rejects malformed URLs with the WeChat article error", () => {
    assert.throws(() => normalizeWechatUrl("not-a-url"), /需要微信原文链接/);
  });

  it("rejects non-WeChat hosts with the WeChat article error", () => {
    assert.throws(
      () => normalizeWechatUrl("https://example.com/s?sn=abc"),
      /需要微信原文链接/,
    );
  });

  it("rejects insecure WeChat article URLs", () => {
    assert.throws(
      () => normalizeWechatUrl("http://mp.weixin.qq.com/s/example"),
      /需要微信原文链接/,
    );
  });
});

describe("canonicalWechatId", () => {
  it("uses the biz mid idx triple when available", () => {
    assert.equal(
      canonicalWechatId(
        "https://mp.weixin.qq.com/s?__biz=MzA1&mid=2247480001&idx=2&sn=abc",
        " account-1 ",
        " title ",
        "2026-08-28T10:00:00Z",
      ),
      "wx:MzA1:2247480001:2",
    );
  });

  it("uses the normalized URL fingerprint when the triple is missing", () => {
    const first = canonicalWechatId(
      "https://mp.weixin.qq.com/s?sn=abc&scene=21&sessionid=1",
      "account-a",
      "title-a",
      "2026-08-28T10:00:00Z",
    );
    const second = canonicalWechatId(
      "https://mp.weixin.qq.com/s?sn=abc&sessionid=99",
      "account-b",
      "title-b",
      "2026-08-29T10:00:00Z",
    );

    assert.match(first, /^wx:url:[a-f0-9]{32}$/);
    assert.equal(second, first);
  });

  it("falls back to account title and publishedAt when the URL is unusable", () => {
    const first = canonicalWechatId(
      "not a url",
      " account-x ",
      " Title X ",
      "2026-08-28T10:00:00Z",
    );
    const second = canonicalWechatId(
      "not a url",
      " account-x ",
      " Title X ",
      "2026-08-28T23:59:59Z",
    );

    assert.match(first, /^wx:fallback:[a-f0-9]{32}$/);
    assert.equal(second, first);
  });
});
