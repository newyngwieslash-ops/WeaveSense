import assert from "node:assert/strict";
import test from "node:test";
import { createDajialaClient } from "./dajiala.mjs";

const baseUrl = "https://www.dajiala.com/fbmain/monitor/v3";
const source = {
  account_id: "gh_example",
  name: "示例号",
  sample_url: "https://mp.weixin.qq.com/s/example",
};
const listArticle = {
  title: "当天文章",
  post_time: 1722416179,
  url: "https://mp.weixin.qq.com/s/list-article",
  cover_url: "https://mmbiz.qpic.cn/list.jpg",
};

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl) {
  return createDajialaClient({
    key: "key-test",
    verifycode: "verify-test",
    baseUrl: `${baseUrl}/`,
    fetchImpl,
  });
}

test("lists today's articles with the exact provider request and no detail call", async () => {
  const calls = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url, init });
    return response({ code: 0, cost_money: 0.06, data: [listArticle] });
  });

  const result = await client.listToday(source);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${baseUrl}/post_condition`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    url: source.sample_url,
    page: 1,
    key: "key-test",
    verifycode: "verify-test",
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    items: [{
      account_id: "gh_example",
      account_name: "示例号",
      title: "当天文章",
      published_at: new Date(1722416179 * 1_000).toISOString(),
      original_url: "https://mp.weixin.qq.com/s/list-article",
      cover_url: "https://mmbiz.qpic.cn/list.jpg",
      provider: "dajiala",
    }],
    cost_money: 0.06,
    attempt: { provider: "dajiala", operation: "list_today", status: "ok", http_status: 200 },
  });
  assert.equal(JSON.stringify(result).includes("key-test"), false);
  assert.equal(JSON.stringify(result).includes("verify-test"), false);
  assert.equal(client.estimatedListCost, 0.08);
  assert.equal(client.estimatedDetailCost, 0.045);
});

test("uses a 20 second native timeout", async () => {
  const original = AbortSignal.timeout;
  let timeoutMs;
  AbortSignal.timeout = (value) => {
    timeoutMs = value;
    return new AbortController().signal;
  };
  try {
    await clientWith(async () => response({ code: 0, cost_money: 0, data: [] })).listToday(source);
    assert.equal(timeoutMs, 20_000);
  } finally {
    AbortSignal.timeout = original;
  }
});

test("enriches one article with the exact detail request", async () => {
  const calls = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url, init });
    return response({
      code: 0,
      cost_money: 0.045,
      title: "详情标题",
      content: "<p>完整正文</p>",
      article_url: "https://mp.weixin.qq.com/s/detail-article",
      cover_url: "https://mmbiz.qpic.cn/detail.jpg",
      nickname: "详情公众号",
      post_time: 1722416180,
    });
  });
  const item = {
    account_id: "gh_example",
    account_name: "示例号",
    title: "当天文章",
    published_at: new Date(1722416179 * 1_000).toISOString(),
    original_url: listArticle.url,
    cover_url: listArticle.cover_url,
    provider: "dajiala",
  };

  const result = await client.enrichArticle(item);

  assert.equal(calls[0].url, `${baseUrl}/article_detail`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    url: listArticle.url,
    key: "key-test",
    verifycode: "verify-test",
  });
  assert.deepEqual(result, {
    ...item,
    account_name: "详情公众号",
    title: "详情标题",
    published_at: new Date(1722416180 * 1_000).toISOString(),
    original_url: "https://mp.weixin.qq.com/s/detail-article",
    cover_url: "https://mmbiz.qpic.cn/detail.jpg",
    body_html: "<p>完整正文</p>",
    cost_money: 0.045,
    attempt: { provider: "dajiala", operation: "article_detail", status: "ok", http_status: 200 },
  });
  assert.equal(JSON.stringify(result).includes("key-test"), false);
  assert.equal(JSON.stringify(result).includes("verify-test"), false);
});

const mappingFailures = [
  ["provider code", () => response({ code: 10002, msg: "key-test verify-test" })],
  ["invalid JSON", () => response("not-json")],
  ["HTTP 400", () => response({ error: "key-test" }, 400)],
  ["non-array list", () => response({ code: 0, data: {} })],
  ["missing article field", () => response({ code: 0, data: [{ ...listArticle, title: "" }] })],
];

for (const [name, makeResponse] of mappingFailures) {
  test(`${name} is a sanitized mapping error`, async () => {
    const client = clientWith(async () => makeResponse());
    await assert.rejects(client.listToday(source), (error) => {
      assert.equal(error.name, "DajialaError");
      assert.equal(error.kind, "mapping_error");
      assert.equal(error.retryable, false);
      assert.equal(JSON.stringify(error).includes("key-test"), false);
      assert.equal(JSON.stringify(error).includes("verify-test"), false);
      assert.equal(error.message.includes("key-test"), false);
      assert.equal(error.message.includes("verify-test"), false);
      assert.deepEqual(error.attempt, {
        provider: "dajiala",
        operation: "list_today",
        status: "error",
        error_type: "mapping_error",
        http_status: name === "HTTP 400" ? 400 : 200,
      });
      return true;
    });
  });
}

const technicalFailures = [
  ["HTTP 429", async () => response({}, 429), 429],
  ["HTTP 503", async () => response({}, 503), 503],
  ["timeout", async () => { throw new DOMException("key-test", "TimeoutError"); }, null],
  ["network", async () => { throw new Error("verify-test"); }, null],
];

for (const [name, fetchImpl, httpStatus] of technicalFailures) {
  test(`${name} is a sanitized retryable technical error`, async () => {
    const client = clientWith(fetchImpl);
    await assert.rejects(client.listToday(source), (error) => {
      assert.equal(error.name, "DajialaError");
      assert.equal(error.kind, "technical_error");
      assert.equal(error.retryable, true);
      assert.equal(JSON.stringify(error).includes("key-test"), false);
      assert.equal(JSON.stringify(error).includes("verify-test"), false);
      assert.deepEqual(error.attempt, {
        provider: "dajiala",
        operation: "list_today",
        status: "error",
        error_type: "technical_error",
        http_status: httpStatus,
      });
      return true;
    });
  });
}

test("missing detail fields fail without leaking credentials", async () => {
  const client = clientWith(async () => response({
    code: 0,
    article_url: listArticle.url,
    cover_url: listArticle.cover_url,
    nickname: "示例号",
    post_time: 1722416179,
  }));
  await assert.rejects(client.enrichArticle({ original_url: listArticle.url }), (error) => {
    assert.equal(error.kind, "mapping_error");
    assert.equal(error.attempt.operation, "article_detail");
    assert.equal(JSON.stringify(error).includes("key-test"), false);
    assert.equal(JSON.stringify(error).includes("verify-test"), false);
    return true;
  });
});

test("validates the API key before making requests", () => {
  assert.throws(() => createDajialaClient({ key: "", baseUrl, fetchImpl: fetch }), /key is required/);
});
