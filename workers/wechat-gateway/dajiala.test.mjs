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

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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
  assert.equal(calls[0].init.redirect, "error");
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
  // T13: the adapter no longer asserts a hardcoded price. The estimate is an
  // operator-supplied upper bound; without one it is null and paid admission is
  // refused (see t13-spend.test.mjs). The previous 0.08 was below the real 0.14
  // charge in the incident record, which is why it must not be a default.
  assert.equal(client.estimatedListCost, null);
  assert.equal(client.estimatedDetailCost, null);
  assert.equal(createDajialaClient({ key: "key-test", baseUrl: baseUrl + "/", fetchImpl: fetch,
    estimatedListCost: 0.2, estimatedDetailCost: 0.1 }).estimatedListCost, 0.2);
  // A zero/negative/garbage bound is refused rather than used as a price.
  assert.equal(createDajialaClient({ key: "key-test", baseUrl: baseUrl + "/", fetchImpl: fetch,
    estimatedListCost: 0 }).estimatedListCost, null);
  assert.equal(createDajialaClient({ key: "key-test", baseUrl: baseUrl + "/", fetchImpl: fetch,
    estimatedListCost: "abc" }).estimatedListCost, null);
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
  assert.equal(calls[0].init.redirect, "error");
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
  ["HTTP 400", () => response({ error: "key-test" }, 400), 400],
  ["non-array list", () => response({ code: 0, data: {} })],
  ["missing article field", () => response({ code: 0, data: [{ ...listArticle, title: "" }] })],
  ["out-of-range timestamp", () => response({ code: 0, data: [{ ...listArticle, post_time: 1e20 }] })],
  ["implausible future timestamp", () => response({ code: 0, data: [{ ...listArticle, post_time: 99999999999 }] })],
  ["fractional timestamp", () => response({ code: 0, data: [{ ...listArticle, post_time: 1722416179.5 }] })],
  ["ambiguous date string", () => response({ code: 0, data: [{ ...listArticle, post_time: "July 31, 2024" }] })],
  ["HTTP 201 missing field", () => response({ code: 0, data: [{ ...listArticle, title: "" }] }, 201), 201],
];

for (const [name, makeResponse, expectedStatus = 200] of mappingFailures) {
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
        // T13: a stable, non-sensitive reason code (never provider text).
        error_code: "invalid_response",
        http_status: expectedStatus,
      });
      return true;
    });
  });
}

// T13: the sub-code is part of the contract — it is what tells an operator
// whether to back off (rate limit), wait out an outage, or check connectivity.
const technicalFailures = [
  ["HTTP 429", async () => response({}, 429), 429, "rate_limited"],
  ["HTTP 503", async () => response({}, 503), 503, "provider_5xx"],
  ["timeout", async () => { throw new DOMException("key-test", "TimeoutError"); }, null, "timeout"],
  ["network", async () => { throw new Error("verify-test"); }, null, "network"],
];

for (const [name, fetchImpl, httpStatus, expectedCode] of technicalFailures) {
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
        // T13: a stable sub-code so an operator can tell a rate limit from a
        // provider outage or a dead connection without reading provider text.
        error_code: expectedCode,
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

test("accepts only a credential-free HTTPS provider base URL", () => {
  for (const invalid of [
    "http://www.dajiala.com/fbmain/monitor/v3",
    "https://user:pass@www.dajiala.com/fbmain/monitor/v3",
    "https://www.dajiala.com/fbmain/monitor/v3?key=secret",
    "https://www.dajiala.com/fbmain/monitor/v3#secret",
  ]) {
    assert.throws(() => createDajialaClient({ key: "key-test", baseUrl: invalid }), /baseUrl/);
  }
});

test("redirect failures are sanitized technical errors", async () => {
  let init;
  const client = clientWith(async (_url, request) => {
    init = request;
    throw new TypeError("redirect exposed key-test verify-test");
  });
  await assert.rejects(client.listToday(source), (error) => {
    assert.equal(error.kind, "technical_error");
    assert.equal(error.retryable, true);
    assert.equal(init.redirect, "error");
    const visible = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    assert.equal(visible.includes("key-test"), false);
    assert.equal(visible.includes("verify-test"), false);
    return true;
  });
});

test("rejects unsafe list article and cover URLs", async () => {
  const unsafe = [
    { ...listArticle, url: "javascript:alert(1)" },
    { ...listArticle, url: "https://mp.weixin.qq.com.evil.test/s/fake" },
    { ...listArticle, url: "http://user@mp.weixin.qq.com/s/userinfo" },
    { ...listArticle, url: "http://mp.weixin.qq.com:80/s/explicit-port" },
    { ...listArticle, cover_url: "https://127.0.0.1/private.jpg" },
    { ...listArticle, cover_url: "http://mmbiz.qpic.cn/insecure.jpg" },
    { ...listArticle, cover_url: "https://mmbiz.qpic.cn.evil.test/fake.jpg" },
  ];
  for (const article of unsafe) {
    await assert.rejects(
      clientWith(async () => response({ code: 0, data: [article] })).listToday(source),
      (error) => error.kind === "mapping_error",
    );
  }
});

test("keeps request article URLs HTTPS-only", async () => {
  let listCalls = 0;
  await assert.rejects(
    clientWith(async () => { listCalls += 1; return response({ code: 0, data: [] }); })
      .listToday({ ...source, sample_url: "http://mp.weixin.qq.com/s/insecure" }),
    (error) => error.kind === "mapping_error",
  );
  assert.equal(listCalls, 0);

  let detailCalls = 0;
  await assert.rejects(
    clientWith(async () => { detailCalls += 1; return response({ code: 0 }); })
      .enrichArticle({ original_url: "http://mp.weixin.qq.com/s/insecure" }),
    (error) => error.kind === "mapping_error",
  );
  assert.equal(detailCalls, 0);
});

test("upgrades provider list article HTTP URLs to HTTPS", async () => {
  const { items } = await clientWith(async () => response({
    code: 0,
    data: [{ ...listArticle, url: "http://mp.weixin.qq.com/s/list?mid=1#part" }],
  })).listToday(source);
  assert.equal(items[0].original_url, "https://mp.weixin.qq.com/s/list?mid=1#part");
});

test("accepts an empty cover and the exact qlogo CDN host", async () => {
  const client = clientWith(async () => response({
    code: 0,
    data: [
      { ...listArticle, cover_url: "" },
      { ...listArticle, url: `${listArticle.url}-2`, cover_url: "https://mmbiz.qlogo.cn/cover.jpg" },
    ],
  }));
  const { items } = await client.listToday(source);
  assert.equal(items[0].cover_url, "");
  assert.equal(items[1].cover_url, "https://mmbiz.qlogo.cn/cover.jpg");
});

test("rejects unsafe detail article and cover URLs", async () => {
  const detail = {
    code: 0,
    title: "详情标题",
    content: "正文",
    article_url: listArticle.url,
    cover_url: listArticle.cover_url,
    nickname: "详情公众号",
    post_time: 1722416180,
  };
  for (const patch of [
    { article_url: "javascript:alert(1)" },
    { cover_url: "https://10.0.0.1/private.jpg" },
  ]) {
    await assert.rejects(
      clientWith(async () => response({ ...detail, ...patch })).enrichArticle({ original_url: listArticle.url }),
      (error) => error.kind === "mapping_error",
    );
  }
});

test("upgrades provider detail article HTTP URLs to HTTPS", async () => {
  const result = await clientWith(async () => response({
    code: 0,
    title: "详情标题",
    content: "正文",
    article_url: "http://mp.weixin.qq.com/s/detail?idx=2#part",
    cover_url: "",
    nickname: "详情公众号",
    post_time: 1722416180,
  })).enrichArticle({ original_url: listArticle.url });
  assert.equal(result.original_url, "https://mp.weixin.qq.com/s/detail?idx=2#part");
});

test("accepts only finite nonnegative numeric provider costs", async () => {
  for (const invalid of [null, "", " ", false, Number.NaN, -1, "-0.01"]) {
    const list = await clientWith(async () => response({ code: 0, cost_money: invalid, data: [] })).listToday(source);
    assert.equal(list.cost_money, 0.08);
  }
  const list = await clientWith(async () => response({ code: 0, cost_money: "0.06", data: [] })).listToday(source);
  assert.equal(list.cost_money, 0.06);

  const detail = await clientWith(async () => response({
    code: 0,
    cost_money: false,
    title: "详情标题",
    content: "正文",
    article_url: listArticle.url,
    cover_url: "",
    nickname: "详情公众号",
    post_time: 1722416180,
  })).enrichArticle({ original_url: listArticle.url });
  assert.equal(detail.cost_money, 0.045);
});

test("normalizes an explicit ISO timestamp", async () => {
  const value = "2024-07-31T12:00:00+08:00";
  const { items } = await clientWith(async () => response({
    code: 0,
    data: [{ ...listArticle, post_time: value }],
  })).listToday(source);
  assert.equal(items[0].published_at, new Date(value).toISOString());
});

test("classifies response body timeout and network errors as sanitized technical errors", async () => {
  for (const failure of [
    new DOMException("key-test verify-test", "TimeoutError"),
    new Error("network exposed key-test verify-test"),
  ]) {
    const body = new ReadableStream({ pull(controller) { controller.error(failure); } });
    const client = clientWith(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await assert.rejects(client.listToday(source), (error) => {
      assert.equal(error.kind, "technical_error");
      const visible = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(visible.includes("key-test"), false);
      assert.equal(visible.includes("verify-test"), false);
      return true;
    });
  }
});

test("rejects a declared response above 4 MiB and cancels it", async () => {
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode("{}"));
      } else controller.close();
    },
    cancel() { cancelled = true; },
  });
  const client = clientWith(async () => new Response(body, {
    status: 200,
    headers: { "content-length": String(4 * 1024 * 1024 + 1) },
  }));
  await assert.rejects(client.listToday(source), (error) => error.kind === "mapping_error");
  assert.equal(cancelled, true);
});

test("rejects and cancels a chunked response above 4 MiB", async () => {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent++ < 2) controller.enqueue(new Uint8Array(3 * 1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const client = clientWith(async () => new Response(body, { status: 200 }));
  await assert.rejects(client.listToday(source), (error) => error.kind === "mapping_error");
  assert.equal(cancelled, true);
});
