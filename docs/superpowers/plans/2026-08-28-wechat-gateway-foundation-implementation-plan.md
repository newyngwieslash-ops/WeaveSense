# WeChat Gateway Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-hosted gateway that converts configured WeWe/RSSHub feeds into authenticated, canonical Atom feeds that Loom can ingest without duplicate WeChat articles.

**Architecture:** A small Node worker owns primary-feed configuration and persistent health state in SQLite through Node's built-in `node:sqlite` module. It exposes one authenticated Atom feed per Loom source. Loom adds a `wechat_gateway` adapter, reuses the existing RSS parser, and uses a canonical WeChat article ID as `external_id`.

**Tech Stack:** Node.js 22, TypeScript, Node test runner, built-in SQLite, fast-xml-parser, TanStack Start, PostgreSQL/PGLite, Docker Compose

---

## File map

- Create `src/lib/wechat-canonical.ts`: canonicalize WeChat URLs and compute stable IDs.
- Create `src/lib/wechat-canonical.test.ts`: canonicalization checks.
- Modify `src/lib/platforms.ts`: register `wechat_gateway` as an adapter and make it the WeChat default.
- Modify `src/lib/server/config.ts`: read gateway URL and token.
- Modify `src/lib/server/http.ts`: allow server-only request headers.
- Create `src/lib/server/rss-parser.ts`: isolate the pure XML parser so Node's test runner does not depend on the `@/` alias.
- Modify `src/lib/server/rss.ts`: call the pure parser while retaining the existing fetch behavior.
- Modify `src/lib/server/collectors/index.ts`: add the authenticated gateway adapter.
- Modify `src/lib/server/scheduler.ts`: preserve full WeChat text and use canonical IDs.
- Create `workers/wechat-gateway/store.mjs`: SQLite-backed source and health state.
- Create `workers/wechat-gateway/primary.mjs`: fetch and validate configured primary feeds.
- Create `workers/wechat-gateway/atom.mjs`: serialize normalized items to Atom 1.0.
- Create `workers/wechat-gateway/server.mjs`: authenticated gateway HTTP server.
- Create `workers/wechat-gateway/gateway.test.mjs`: worker contract checks.
- Create `workers/wechat-gateway/fixtures/primary.atom`: deterministic Docker smoke fixture.
- Create `workers/wechat-gateway/fixture-server.mjs`: serve the deterministic fixture only under the Compose `qa` profile.
- Modify `package.json`: add gateway start/test scripts and new TypeScript tests.
- Modify `docker-compose.yml`: add the gateway service and persistent volume.
- Modify `env.example`: document non-secret gateway settings and secret names.

### Task 1: Stable WeChat article identity

**Files:**
- Create: `src/lib/wechat-canonical.ts`
- Create: `src/lib/wechat-canonical.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing canonicalization tests**

```ts
// src/lib/wechat-canonical.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWechatId, normalizeWechatUrl } from "./wechat-canonical.ts";

test("uses biz, mid, and idx when present", () => {
  assert.equal(
    canonicalWechatId(
      "https://mp.weixin.qq.com/s?__biz=MzA1&mid=2247480001&idx=2&sn=abc&scene=21",
      "示例号",
      "标题",
      "2026-08-28T08:00:00+08:00",
    ),
    "wx:MzA1:2247480001:2",
  );
});

test("removes tracking parameters but keeps content parameters", () => {
  assert.equal(
    normalizeWechatUrl(
      "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc&scene=21#wechat_redirect",
    ),
    "https://mp.weixin.qq.com/s?__biz=MzA1&idx=1&mid=9&sn=abc",
  );
});

test("uses the normalized original URL when canonical parameters are absent", () => {
  const a = canonicalWechatId("https://mp.weixin.qq.com/s/short-code?scene=21", "示例号", "同一标题", "2026-08-28");
  const b = canonicalWechatId("https://mp.weixin.qq.com/s/short-code", "另一个名字", "另一个标题", "2026-08-29");
  assert.equal(a, b);
  assert.match(a, /^wx:url:[a-f0-9]{32}$/);
});

test("falls back to account, title, and date only for an unusable URL", () => {
  assert.match(
    canonicalWechatId("not-a-url", "示例号", "同一标题", "2026-08-28"),
    /^wx:fallback:[a-f0-9]{32}$/,
  );
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `node --experimental-strip-types --test src/lib/wechat-canonical.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `wechat-canonical.ts`.

- [ ] **Step 3: Add the minimal canonicalization implementation**

```ts
// src/lib/wechat-canonical.ts
import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "scene", "sessionid", "clicktime", "enterid", "ascene", "devicetype",
  "version", "nettype", "lang", "exportkey", "pass_ticket", "wx_header",
  "chksm", "mpshare", "srcid", "sharer_shareinfo", "sharer_shareinfo_first",
  "from", "isappinstalled",
]);

export function normalizeWechatUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname !== "mp.weixin.qq.com") throw new Error("需要微信原文链接");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function canonicalWechatId(
  rawUrl: string,
  accountId: string,
  title: string,
  publishedAt: string,
): string {
  try {
    const normalized = normalizeWechatUrl(rawUrl);
    const url = new URL(normalized);
    const biz = url.searchParams.get("__biz");
    const mid = url.searchParams.get("mid");
    const idx = url.searchParams.get("idx");
    if (biz && mid && idx) return `wx:${biz}:${mid}:${idx}`;
    return `wx:url:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
  } catch {
    // The caller still rejects invalid original links before persistence.
  }
  const material = [accountId.trim(), title.trim(), publishedAt.slice(0, 10)].join("\n");
  return `wx:fallback:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}
```

- [ ] **Step 4: Run the canonicalization tests**

Run: `node --experimental-strip-types --test src/lib/wechat-canonical.test.ts`

Expected: 4 tests PASS.

- [ ] **Step 5: Add the test to the project test command**

Change the `test` script in `package.json` to include:

```json
"test": "node --test 'scripts/**/*.test.mjs' 'workers/**/*.test.mjs' && node --experimental-strip-types --test src/lib/wechat-canonical.test.ts src/lib/app-data/app-data.test.ts src/lib/auth/gate-identity.test.ts"
```

- [ ] **Step 6: Commit the identity helper**

```bash
git add package.json src/lib/wechat-canonical.ts src/lib/wechat-canonical.test.ts
git commit -m "feat: add stable WeChat article identity"
```

### Task 2: Parse authenticated gateway Atom feeds

**Files:**
- Modify: `src/lib/platforms.ts`
- Modify: `src/lib/server/config.ts`
- Modify: `src/lib/server/http.ts`
- Create: `src/lib/server/rss-parser.ts`
- Modify: `src/lib/server/rss.ts`
- Modify: `src/lib/server/collectors/index.ts`
- Modify: `src/lib/server/scheduler.ts`
- Create: `src/lib/server/rss.test.ts`

- [ ] **Step 1: Write a failing Atom extension test**

```ts
// src/lib/server/rss.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedXml } from "./rss-parser.ts";

test("reads canonical id, provider, full text, and thumbnail", () => {
  const body = "正文".repeat(5_000);
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:loom="https://loom.local/ns" xmlns:media="http://search.yahoo.com/mrss/">
    <entry><id>wx:MzA1:9:1</id><title>标题</title><published>2026-08-28T08:00:00+08:00</published>
    <link rel="alternate" href="https://mp.weixin.qq.com/s?__biz=MzA1&amp;mid=9&amp;idx=1&amp;sn=abc"/>
    <author><name>示例号</name></author><content><![CDATA[${body}]]></content>
    <media:thumbnail url="https://mmbiz.qpic.cn/cover.jpg"/><loom:provider>primary</loom:provider>
    <loom:discovered_at>2026-08-28T09:00:00Z</loom:discovered_at></entry></feed>`;
  const [item] = parseFeedXml(xml, "source-1", "wechat");
  assert.equal(item.external_id, "wx:MzA1:9:1");
  assert.equal(item.body.length, body.length);
  assert.equal(item.thumbnail_url, "https://mmbiz.qpic.cn/cover.jpg");
  assert.deepEqual(item.extra, { platform: "wechat", provider: "primary", discovered_at: "2026-08-28T09:00:00Z" });
});
```

- [ ] **Step 2: Run the test and verify it fails on author/provider/full-text behavior**

Run: `node --experimental-strip-types --test src/lib/server/rss.test.ts`

Expected: FAIL because nested Atom author and Loom extensions are not parsed as required.

- [ ] **Step 3: Extend the shared HTTP helper without changing existing callers**

Change `fetchText` to accept an optional fourth argument:

```ts
export async function fetchText(
  url: string,
  timeoutMs = 10000,
  accept = "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8",
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: accept,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
```

- [ ] **Step 4: Add gateway configuration**

Append to `prod` in `src/lib/server/config.ts`:

```ts
wechatGatewayUrl: read("WECHAT_GATEWAY_URL").replace(/\/$/, ""),
wechatGatewayToken: read("WECHAT_GATEWAY_TOKEN"),
```

Add:

```ts
export function wechatGatewayConfigured(): boolean {
  return Boolean(prod.wechatGatewayUrl && prod.wechatGatewayToken);
}
```

- [ ] **Step 5: Register the adapter and gateway fetch path**

In `src/lib/platforms.ts`, add `"wechat_gateway"` to `AdapterId` and set the WeChat platform's adapter to `"wechat_gateway"`.

In `src/lib/server/collectors/index.ts`, add:

```ts
import { prod, wechatGatewayConfigured } from "../config";

const wechatGatewayAdapter: CollectorAdapter = {
  id: "wechat_gateway",
  async fetch(source) {
    if (!wechatGatewayConfigured()) throw new Error("微信公众号源网关未配置");
    const xml = await fetchText(
      `${prod.wechatGatewayUrl}/v1/feeds/${encodeURIComponent(source.id)}.atom`,
      20_000,
      "application/atom+xml",
      { Authorization: `Bearer ${prod.wechatGatewayToken}` },
    );
    return parseFeedXml(xml, source.id, "wechat");
  },
};
```

Also import `fetchText` and `parseFeedXml`, add `wechat_gateway: wechatGatewayAdapter` to `ADAPTERS`, and return `wechat_gateway` from `defaultAdapter("wechat")`.

- [ ] **Step 6: Extract and extend the pure parser**

Move `parseFeedXml` and its XML-only helpers from `rss.ts` to `rss-parser.ts`. Use relative imports in the new file so the standalone test command can load it:

```ts
import { XMLParser } from "fast-xml-parser";
import type { MediaType } from "../platforms.ts";
import { stripHtml } from "../format.ts";
import type { NormalizedItem } from "./collectors/types.ts";
```

Import `parseFeedXml` back into `rss.ts`, and re-export it to preserve any existing callers. Replace the author extraction and `extra` creation in `rss-parser.ts` with:

In `parseFeedXml`, replace the author extraction and `extra` creation with:

```ts
const authorRaw = raw.author as Record<string, unknown> | undefined;
const author = stripHtml(
  textOf(raw["dc:creator"] ?? authorRaw?.name ?? raw.author ?? raw["itunes:author"] ?? ""),
);
const provider = textOf(raw["loom:provider"]);
const discoveredAt = textOf(raw["loom:discovered_at"]);
extra: {
  platform,
  ...(provider ? { provider } : {}),
  ...(discoveredAt ? { discovered_at: discoveredAt } : {}),
  ...(bodyTooLarge ? { body_error: "body_too_large" } : {}),
},
```

Do not discard required metadata when an individual body exceeds 2 MB. Clear only the body and record a structured extraction error before `stripHtml`:

```ts
const rawBody = textOf(raw["content:encoded"] ?? raw.content ?? raw.description ?? raw.summary ?? raw["media:description"]);
const bodyTooLarge = Buffer.byteLength(rawBody, "utf8") > 2 * 1024 * 1024;
const body = bodyTooLarge ? "" : stripHtml(rawBody);
```

Add `body_error: "body_too_large"` to `extra` only when `bodyTooLarge` is true. Extend `rss.test.ts` with a 2 MiB + 1 byte body and assert the article remains present with an empty body and the error marker.

- [ ] **Step 7: Remove the 8,000-character WeChat truncation**

In `persistHit`, where the local platform variable is named `platform`, replace `it.body.slice(0, 8000)` with:

```ts
platform === "wechat" ? it.body : it.body.slice(0, 8000)
```

In `runSourceJob`, replace the same expression with:

```ts
source.platform === "wechat" ? it.body : it.body.slice(0, 8000)
```

Do not change non-WeChat behavior.

- [ ] **Step 8: Run focused checks**

Run: `node --experimental-strip-types --test src/lib/server/rss.test.ts src/lib/wechat-canonical.test.ts`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 9: Commit the gateway adapter**

```bash
git add src/lib/platforms.ts src/lib/server/config.ts src/lib/server/http.ts src/lib/server/rss-parser.ts src/lib/server/rss.ts src/lib/server/rss.test.ts src/lib/server/collectors/index.ts src/lib/server/scheduler.ts
git commit -m "feat: ingest authenticated WeChat gateway feeds"
```

### Task 3: Primary-feed gateway worker

**Files:**
- Create: `workers/wechat-gateway/store.mjs`
- Create: `workers/wechat-gateway/primary.mjs`
- Create: `workers/wechat-gateway/atom.mjs`
- Create: `workers/wechat-gateway/server.mjs`
- Create: `workers/wechat-gateway/gateway.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing gateway contract tests**

Create tests that import the pure helpers, not a live port:

```js
// workers/wechat-gateway/gateway.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { authorize, validateSourceInput } from "./server.mjs";
import { toAtom } from "./atom.mjs";

test("requires an exact bearer token", () => {
  assert.equal(authorize(new Headers({ authorization: "Bearer gateway-test" }), "gateway-test"), true);
  assert.equal(authorize(new Headers({ authorization: "Bearer wrong" }), "gateway-test"), false);
});

test("requires a WeChat sample URL and HTTP feed", () => {
  assert.deepEqual(validateSourceInput({
    id: "wx-1", name: "示例号", account_id: "gh_example",
    sample_url: "https://mp.weixin.qq.com/s/example",
    primary_feed_url: "https://feeds.internal/wx-1.atom",
  }).id, "wx-1");
  assert.throws(() => validateSourceInput({ id: "wx-1", name: "示例号" }), /sample_url/);
});

test("serializes the required Atom contract", () => {
  const xml = toAtom("wx-1", "示例号", [{
    canonical_id: "wx:MzA1:9:1", account_id: "gh_example", account_name: "示例号",
    title: "标题", published_at: "2026-08-28T08:00:00+08:00",
    original_url: "https://mp.weixin.qq.com/s?__biz=MzA1&mid=9&idx=1&sn=abc",
    body_text: "正文", cover_url: "https://mmbiz.qpic.cn/cover.jpg",
    provider: "primary", discovered_at: "2026-08-28T09:00:00Z",
  }]);
  assert.match(xml, /wx:MzA1:9:1/);
  assert.match(xml, /loom:provider>primary/);
  assert.match(xml, /media:thumbnail/);
});
```

- [ ] **Step 2: Run and verify the missing-module failures**

Run: `node --test workers/wechat-gateway/gateway.test.mjs`

Expected: FAIL with missing `server.mjs` or `atom.mjs` exports.

- [ ] **Step 3: Implement the built-in SQLite store**

`workers/wechat-gateway/store.mjs` must import `DatabaseSync` from `node:sqlite` and export `openStore(path)`. On open, create `gateway_sources` with the exact fields from the design plus `name`, `sample_url`, `created_at`, and `updated_at`. Return methods `upsertSource`, `getSource`, `listSources`, `recordPrimarySuccess`, and `recordPrimaryFailure`. Use prepared statements and one `DatabaseSync` instance; tests pass `:memory:`.

Use this schema:

```sql
create table if not exists gateway_sources (
  source_id text primary key,
  account_id text not null,
  name text not null,
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  sample_url text not null,
  primary_feed_url text not null,
  last_primary_ok_at text,
  consecutive_primary_failures integer not null default 0,
  last_paid_check_at text,
  last_paid_result text not null default '',
  next_retry_at text,
  alert_state text not null default 'normal',
  created_at text not null,
  updated_at text not null
);
```

- [ ] **Step 4: Implement primary feed normalization**

`workers/wechat-gateway/primary.mjs` must export `fetchPrimary(source, now = new Date())`. Fetch `source.primary_feed_url` with a 20-second timeout, parse it with `fast-xml-parser`, and map at most 24 entries to the logical structure in the design. Validate `mp.weixin.qq.com` links, titles, and parseable dates. Use the same canonical algorithm as `src/lib/wechat-canonical.ts`; keep a small mirrored JavaScript function and a parity test with the three canonical fixtures from Task 1.

- [ ] **Step 5: Implement XML-safe Atom output**

`workers/wechat-gateway/atom.mjs` must export `toAtom(sourceId, sourceName, items)`. Escape XML text and attributes, emit Atom 1.0 plus `media` and `loom` namespaces, and use CDATA only after replacing every `]]>` with `]]]]><![CDATA[>`.

- [ ] **Step 6: Implement the authenticated HTTP server**

`workers/wechat-gateway/server.mjs` must:

- export `authorize` and `validateSourceInput` without starting a server during import;
- require `WECHAT_GATEWAY_TOKEN`, `GATEWAY_DB_PATH`, and `PORT` at process start;
- expose `PUT /v1/sources/:id`, `GET /v1/sources/:id/health`, and `GET /v1/feeds/:id.atom`;
- return 401 for a missing/wrong token, 404 for an unknown source, 422 for invalid source input, and JSON errors without stack traces;
- record primary success/failure and return Atom on success;
- start only when `import.meta.url === pathToFileURL(process.argv[1]).href`.

The source PUT body is exactly:

```json
{
  "name": "示例号",
  "account_id": "gh_example",
  "priority": "normal",
  "sample_url": "https://mp.weixin.qq.com/s/example",
  "primary_feed_url": "https://feeds.internal/wx-1.atom"
}
```

- [ ] **Step 7: Add worker scripts**

Add to `package.json`:

```json
"gateway:start": "node workers/wechat-gateway/server.mjs",
"gateway:test": "node --test workers/wechat-gateway/*.test.mjs"
```

- [ ] **Step 8: Run gateway and project checks**

Run: `npm run gateway:test`

Expected: all gateway tests PASS.

Run: `npm test`

Expected: all project tests PASS.

- [ ] **Step 9: Commit the primary gateway**

```bash
git add package.json workers/wechat-gateway
git commit -m "feat: add primary WeChat feed gateway"
```

### Task 4: Docker wiring and a live primary-feed smoke check

**Files:**
- Modify: `docker-compose.yml`
- Modify: `env.example`
- Modify: `README.md`
- Create: `workers/wechat-gateway/fixtures/primary.atom`
- Create: `workers/wechat-gateway/fixture-server.mjs`

- [ ] **Step 1: Add the gateway service and volume**

Add this service to `docker-compose.yml`:

```yaml
  wechat-gateway:
    build: .
    command: ["npm", "run", "gateway:start"]
    environment:
      WECHAT_GATEWAY_TOKEN: ${WECHAT_GATEWAY_TOKEN:-change-me}
      GATEWAY_DB_PATH: /data/wechat-gateway.sqlite
      PORT: "8790"
    volumes:
      - wechat-gateway-data:/data
    restart: unless-stopped
```

Add `wechat-gateway-data:` under `volumes`. Add to the app service:

```yaml
      WECHAT_GATEWAY_URL: http://wechat-gateway:8790
      WECHAT_GATEWAY_TOKEN: ${WECHAT_GATEWAY_TOKEN:-change-me}
```

Add an app dependency on `wechat-gateway` with `condition: service_started`.

- [ ] **Step 2: Document configuration**

Add these names to `env.example` without real values:

```text
WECHAT_GATEWAY_URL=http://wechat-gateway:8790
WECHAT_GATEWAY_TOKEN=
```

In `README.md`, add a short “微信公众号源网关” section describing that a configured WeWe/RSSHub-compatible feed remains the primary source and secrets stay in the runtime environment.

- [ ] **Step 3: Add a deterministic QA-only feed**

Create `workers/wechat-gateway/fixtures/primary.atom` with two entries: both valid `mp.weixin.qq.com` URLs, one body longer than 8,000 characters, and one `media:thumbnail`. Create `fixture-server.mjs` with Node's `http` module; it listens on `0.0.0.0:8791`, serves that file at `/primary.atom`, and returns 404 elsewhere.

Add this Compose service so it never starts in the normal stack:

```yaml
  wechat-fixture:
    profiles: ["qa"]
    build: .
    command: ["node", "workers/wechat-gateway/fixture-server.mjs"]
```

- [ ] **Step 4: Build the containers**

Run: `docker compose --profile qa build app wechat-gateway wechat-fixture`

Expected: both images build successfully.

- [ ] **Step 5: Start the QA stack and provision the fixture source**

Run: `docker compose --profile qa up -d postgres wechat-fixture wechat-gateway app`

Expected: all three services report running.

Send this exact JSON to `PUT http://wechat-gateway:8790/v1/sources/wx-fixture` from inside the app container, using `Authorization: Bearer change-me`:

```json
{
  "name": "微信测试源",
  "account_id": "gh_fixture",
  "priority": "normal",
  "sample_url": "https://mp.weixin.qq.com/s/fixture",
  "primary_feed_url": "http://wechat-fixture:8791/primary.atom"
}
```

Expected: HTTP 200 and a JSON body containing `{ "ok": true }`.

- [ ] **Step 6: Verify Atom and Loom ingestion**

Request the gateway Atom endpoint from inside the app container. Expected: HTTP 200, `application/atom+xml`, visible `<entry>` elements, canonical `<id>` values, and no gateway error.

Run the existing manual scan for that source. Expected: one job completes, required fields appear in `items`, and a second scan inserts zero duplicates.

- [ ] **Step 7: Run the standard quality gates**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ /workspace/screenshots/wechat-plan1-dev.png`

Expected: desktop and mobile verdicts are clean and the browser console has no uncaught errors. Visually inspect `/workspace/screenshots/wechat-plan1-dev.png` and `/workspace/screenshots/wechat-plan1-dev-mobile.png` in one batched image read.

Run: `npm run preview:restart`

Expected: built output starts on `127.0.0.1:8081`.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8081/ /workspace/screenshots/wechat-plan1-built.png --baseline /workspace/screenshots/wechat-plan1-dev.json`

Expected: production render is clean and does not diverge from the dev baseline.

- [ ] **Step 8: Commit Docker wiring**

```bash
git add docker-compose.yml env.example README.md workers/wechat-gateway/fixtures/primary.atom workers/wechat-gateway/fixture-server.mjs
git commit -m "ops: run WeChat gateway with Loom"
```

## Plan 1 completion gate

Plan 1 is complete when one configured third-party public account is ingested through the authenticated gateway, a repeated scan creates no duplicate, the full plain-text body is retained below 2 MB, the cover is mapped when present, and all project quality gates pass.
