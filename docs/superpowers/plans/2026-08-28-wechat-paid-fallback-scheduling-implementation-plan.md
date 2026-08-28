# WeChat Paid Fallback and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a budget-capped 极致了 fallback, same-day reconciliation, and an always-on scheduler so 100+ configured WeChat accounts continue collecting when a primary feed fails.

**Architecture:** The gateway tries the configured primary feed first. Two consecutive primary failures or six hours without a primary success make that source eligible for paid lookup; a 23:30 Asia/Shanghai reconciliation checks every source not successfully verified by the provider that day. A SQLite reservation ledger enforces both daily call and RMB ceilings before every request. A separate Compose scheduler calls a token-protected TanStack server route every 30 minutes; source records remain due only every 60 minutes, while the half-hour cadence guarantees a 23:30 reconciliation.

**Tech Stack:** Node.js 22, built-in SQLite, Node test runner, fast-xml-parser, TanStack Start server routes, Docker Compose

**Provider contract verified 2026-08-28:** 极致了 `post_condition` is `POST https://www.dajiala.com/fbmain/monitor/v3/post_condition` with JSON `{ url, page, key, verifycode }`; `article_detail` Pro is `POST https://www.dajiala.com/fbmain/monitor/v3/article_detail` with JSON `{ url, key, verifycode }`. Keep these URLs configurable because third-party contracts can change. References: [daily article API](https://apifox.com/apidoc/shared-410674f9-f451-4b4f-957a-5f54f243bc83/api-199748761), [article detail Pro](https://apifox.com/apidoc/shared/410674f9-f451-4b4f-957a-5f54f243bc83/api-199752498), [current pricing](https://www.dajiala.com/main/interface?actnav=0).

**Repository note:** The current workspace is not a Git repository. Execute each `git commit` checkpoint after restoring or initializing repository metadata; until then, run the checks and keep the task boundaries unchanged.

## File map

- Create `workers/wechat-gateway/state-machine.mjs`: pure fallback/reconciliation decisions and Shanghai date helpers.
- Create `workers/wechat-gateway/state-machine.test.mjs`: threshold, retry, reconciliation, and budget checks.
- Create `workers/wechat-gateway/dajiala.mjs`: strict 极致了 client and response normalization.
- Create `workers/wechat-gateway/dajiala.test.mjs`: request/response/error contract checks with injected fetch.
- Modify `workers/wechat-gateway/store.mjs`: provider usage ledger, per-source paid state, and normalized article cache.
- Modify `workers/wechat-gateway/server.mjs`: primary-first fallback, per-source locks, reconciliation endpoint, provider health.
- Modify `workers/wechat-gateway/atom.mjs`: include attempt metadata without exposing secrets.
- Create `src/routes/api/cron/tick.ts`: token-protected server-side scheduling endpoint.
- Create `src/lib/server/cron.ts`: pure token and reconciliation-time helpers.
- Create `src/lib/server/cron.test.ts`: authorization and once-per-day reconciliation tests.
- Create `scripts/cron-loop.mjs`: two-minute scheduler process.
- Create `scripts/cron-loop.test.mjs`: loop configuration and request contract checks.
- Modify `src/lib/server/config.ts`: scheduler, gateway reconciliation, and tick-limit settings.
- Modify `package.json`: test and scheduler scripts.
- Modify `docker-compose.yml`: scheduler service and paid-provider environment.
- Modify `env.example`: document secret names and safe defaults.
- Modify `README.md`: operations and cost ceiling.

### Task 1: Encode fallback and reconciliation rules as pure logic

**Files:**
- Create: `workers/wechat-gateway/state-machine.mjs`
- Create: `workers/wechat-gateway/state-machine.test.mjs`

- [ ] **Step 1: Write failing state-machine tests**

```js
// workers/wechat-gateway/state-machine.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { alertState, paidDecision, shanghaiDay, shouldReconcile } from "./state-machine.mjs";

const now = new Date("2026-08-28T15:35:00Z"); // Shanghai 23:35

test("uses paid fallback after two consecutive primary failures", () => {
  assert.deepEqual(paidDecision({ consecutive_primary_failures: 2, next_retry_at: null }, now), {
    allowed: true,
    reason: "primary_failed",
  });
});

test("respects paid retry backoff", () => {
  assert.equal(paidDecision({
    consecutive_primary_failures: 4,
    next_retry_at: "2026-08-28T16:00:00Z",
  }, now).allowed, false);
});

test("reconciles once after 23:30 Shanghai when today has not succeeded", () => {
  assert.equal(shanghaiDay(now), "2026-08-28");
  assert.equal(shouldReconcile({ last_paid_check_at: "2026-08-27T15:40:00Z", last_paid_result: "ok" }, now), true);
  assert.equal(shouldReconcile({ last_paid_check_at: "2026-08-28T14:00:00Z", last_paid_result: "ok" }, now), false);
  assert.equal(shouldReconcile({ last_paid_check_at: "2026-08-28T14:00:00Z", last_paid_result: "technical_error" }, now), true);
});

test("allows fallback after six hours without a primary success", () => {
  assert.equal(paidDecision({
    consecutive_primary_failures: 1,
    last_primary_ok_at: "2026-08-28T09:00:00Z",
    created_at: "2026-08-28T08:00:00Z",
    next_retry_at: null,
  }, now).allowed, true);
});

test("raises an alert after 24 hours without any successful check", () => {
  assert.equal(alertState({
    last_primary_ok_at: "2026-08-27T14:00:00Z",
    last_paid_check_at: "2026-08-27T13:00:00Z",
    last_paid_result: "technical_error",
  }, now), "alert");
});
```

- [ ] **Step 2: Verify the module is missing**

Run: `node --test workers/wechat-gateway/state-machine.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the minimum decision module**

Export constants `PRIMARY_FAILURE_THRESHOLD = 2` and `PAID_RETRY_MINUTES = [5, 15, 60]`. Export `shanghaiDay(now)` and `shanghaiHourMinute(now)` using `Intl.DateTimeFormat` with `Asia/Shanghai`. Export `paidDecision(source, now)` for the two-failure/six-hour/backoff rule, `shouldReconcile(source, now)` for the 23:30 and same-day-paid-success rule, `nextPaidRetry(now, failedAttemptCount)` for the 5/15/60-minute sequence, and `alertState(source, now)` for `normal|degraded|paid_fallback|alert` based on the latest successful primary or paid check.

`paidDecision` returns only `{ allowed, reason }`; it never reads environment variables or mutates storage. `nextPaidRetry` uses 60 minutes for every attempt after the third.

- [ ] **Step 4: Run the focused test**

Run: `node --test workers/wechat-gateway/state-machine.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the rules**

```bash
git add workers/wechat-gateway/state-machine.mjs workers/wechat-gateway/state-machine.test.mjs
git commit -m "feat: define WeChat fallback policy"
```

### Task 2: Add an exact, testable 极致了 client

**Files:**
- Create: `workers/wechat-gateway/dajiala.mjs`
- Create: `workers/wechat-gateway/dajiala.test.mjs`

- [ ] **Step 1: Write failing client tests with an injected fetch**

Cover all of these cases:

- `listToday(source)` sends `POST /post_condition` with `url: source.sample_url`, `page: 1`, `key`, and `verifycode`.
- a `code: 0` list maps `title`, `post_time`, `url`, and `cover_url` without calling article detail;
- `enrichArticle(item)` sends `POST /article_detail` and maps `content`, `article_url`, `cover_url`, `nickname`, and `post_time`;
- `code !== 0`, invalid JSON, HTTP non-2xx, a non-array list, and missing required article fields throw sanitized errors;
- neither thrown errors nor returned attempt metadata contain the API key or verify code.

Use this injected-fetch shape:

```js
const client = createDajialaClient({
  key: "key-test",
  verifycode: "verify-test",
  baseUrl: "https://www.dajiala.com/fbmain/monitor/v3",
  fetchImpl: async (url, init) => new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
```

- [ ] **Step 2: Run and verify the missing module**

Run: `node --test workers/wechat-gateway/dajiala.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the client**

`createDajialaClient(config)` validates `key`, normalizes `baseUrl`, and returns:

```js
{
  listToday(source),
  enrichArticle(item),
  estimatedListCost: 0.08,
  estimatedDetailCost: 0.045,
}
```

Both methods use `AbortSignal.timeout(20_000)`, `content-type: application/json`, and a shared `postJson(path, body)` helper. Normalize timestamps to ISO strings. Classify HTTP 400–499 except 429 as `mapping_error` with no automatic retry; classify timeout, network, 429, and 500–599 as `technical_error` eligible for the 5/15/60-minute scheduled backoff. Keep list results useful even when detail enrichment later fails: title, publication time, original URL, and cover are the required floor.

- [ ] **Step 4: Run client tests**

Run: `node --test workers/wechat-gateway/dajiala.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the client**

```bash
git add workers/wechat-gateway/dajiala.mjs workers/wechat-gateway/dajiala.test.mjs
git commit -m "feat: add Dajiala fallback client"
```

### Task 3: Enforce the daily budget in SQLite

**Files:**
- Modify: `workers/wechat-gateway/store.mjs`
- Modify: `workers/wechat-gateway/gateway.test.mjs`

- [ ] **Step 1: Add failing ledger tests**

Open an in-memory store and assert:

```js
assert.equal(store.tryReserveSpend("2026-08-28", "dajiala", 0.08, 0.10, 2), true);
assert.equal(store.tryReserveSpend("2026-08-28", "dajiala", 0.08, 0.10, 2), false);
store.adjustSpend("2026-08-28", "dajiala", 0.08, 0.06);
assert.deepEqual(store.getProviderUsage("2026-08-28", "dajiala"), {
  calls: 1,
  amount: 0.06,
});
```

Also assert `recordPaidResult` updates `last_paid_check_at`, `last_paid_result`, `next_retry_at`, and `alert_state` without changing `last_primary_ok_at`.

Add a cache test that upserts the same `canonical_id` first from `primary` and then from `dajiala`; assert one row remains, `providers_seen` contains both values, a non-empty body/cover is never overwritten by an empty value, and `listGatewayItems(sourceId, since)` returns the merged article.

- [ ] **Step 2: Run the worker tests and confirm missing methods**

Run: `npm run gateway:test`

Expected: FAIL because ledger methods do not exist.

- [ ] **Step 3: Add the provider usage table**

```sql
create table if not exists provider_usage (
  day text not null,
  provider text not null,
  calls integer not null default 0,
  amount real not null default 0,
  updated_at text not null,
  primary key (day, provider)
);
```

No separate reconciliation flag is required: use `last_paid_check_at` plus `last_paid_result`. A paid success on the current Shanghai day skips reconciliation; a paid technical failure remains eligible after its configured backoff.

Create the normalized cache table:

```sql
create table if not exists gateway_items (
  source_id text not null,
  canonical_id text not null,
  account_id text not null,
  account_name text not null,
  title text not null,
  published_at text not null,
  original_url text not null,
  body_text text not null default '',
  cover_url text not null default '',
  provider text not null,
  providers_seen text not null default '[]',
  discovered_at text not null,
  updated_at text not null,
  primary key (source_id, canonical_id)
);
```

Return `upsertGatewayItems(sourceId, items)`, `listGatewayItems(sourceId, sinceIso)`, and `deleteGatewayItemsBefore(cutoffIso)`. Upsert merges provider history and uses non-empty incoming body/cover while preserving existing non-empty values.

- [ ] **Step 4: Implement atomic reservation and adjustment**

`tryReserveSpend(day, provider, estimate, dailyRmbCap, dailyCallCap)` uses `BEGIN IMMEDIATE`, reads the current amount and call count, and commits an increment only when both `amount + estimate <= dailyRmbCap` and `calls + 1 <= dailyCallCap`. `adjustSpend` replaces the estimate with the provider's returned `cost_money`, clamped to zero minimum. Roll back on every exception. Health state becomes `warning` at 80% of either cap and `budget_exhausted` when either cap is reached.

- [ ] **Step 5: Run worker tests**

Run: `npm run gateway:test`

Expected: all tests PASS.

- [ ] **Step 6: Commit the ledger**

```bash
git add workers/wechat-gateway/store.mjs workers/wechat-gateway/gateway.test.mjs
git commit -m "feat: cap paid WeChat provider spend"
```

### Task 4: Integrate primary-first fallback and daily reconciliation

**Files:**
- Modify: `workers/wechat-gateway/server.mjs`
- Modify: `workers/wechat-gateway/atom.mjs`
- Modify: `workers/wechat-gateway/gateway.test.mjs`

- [ ] **Step 1: Add failing integration tests**

Refactor the gateway to export `createGateway({ store, primary, paid, token, dailyBudget, now })`, returning a request handler. Test with in-memory fakes:

1. primary success caches normalized items, returns Atom with `loom:provider=primary`, and never calls paid;
2. first primary failure returns 503 and records failure, but does not spend;
3. second failure reserves list cost, calls `listToday`, enriches only new articles whose body is absent, and returns Atom with `loom:provider=dajiala`;
4. detail failure keeps list-level title/time/link/cover and returns a successful feed;
5. exhausted budget returns 429 with `code: "paid_budget_exhausted"`;
6. `POST /v1/reconcile` before 23:30 returns zero attempted;
7. reconciliation after 23:30 persists paid articles, returns their successful source IDs, and the second call that day skips them;
8. concurrent requests for the same source share one in-flight promise and cause one provider call;
9. a successful feed response is served from the normalized SQLite cache on an immediate sequential request, and paid reconciliation articles remain present even when the next primary feed omits them.

- [ ] **Step 2: Run and verify failures**

Run: `npm run gateway:test`

Expected: the new integration cases FAIL.

- [ ] **Step 3: Wire fallback without weakening the primary path**

Implement one `Map<string, Promise<Response>>` source lock. The feed algorithm is exact:

1. fetch and validate primary;
2. on success, upsert its items, record primary success, and return the union of the current result plus cached items published in the last seven days;
3. on failure, increment primary failures;
4. if fewer than two failures or paid retry is not due, return 503;
5. reserve 0.08 RMB before `listToday`;
6. adjust the reservation to response `cost_money`;
7. for each returned article not already present in the primary result, reserve 0.045 RMB before detail enrichment; if budget or detail fails, keep list-level fields;
8. upsert list/detail results into `gateway_items`, record the paid result and next retry;
9. serialize cached items published in the last seven days to Atom;
10. delete cache rows older than 30 days after a successful source request.

Use `DAJIALA_DAILY_BUDGET_RMB=20` and `DAJIALA_DAILY_CALL_LIMIT=250` as defaults. A missing `DAJIALA_KEY` means fallback is disabled, not a process-start failure; the health endpoint reports `paid_configured: false`. The normalized SQLite cache is the only article cache; do not add a competing in-memory truth.

- [ ] **Step 4: Add the reconciliation route**

`POST /v1/reconcile` requires the gateway bearer token and accepts no client-selected date. It uses server time in Asia/Shanghai and returns `{ day, attempted, succeeded, failed, succeeded_source_ids, budget_exhausted }`. Paid results are upserted before a source ID enters `succeeded_source_ids`. A source whose `last_paid_check_at` is today and `last_paid_result` is successful is skipped; a technical failure may retry only after its 5/15/60-minute backoff. Order candidates by `priority='high'` first, then oldest successful check. Once either budget reaches 80%, keep that priority order and set the aggregate warning; at 100%, stop before the next reservation.

- [ ] **Step 5: Extend health output**

`GET /v1/sources/:id/health` returns:

```json
{
  "source_id": "wx-1",
  "alert_state": "normal",
  "last_primary_ok_at": "2026-08-28T10:00:00.000Z",
  "consecutive_primary_failures": 0,
  "last_paid_check_at": null,
  "last_paid_result": "",
  "next_retry_at": null,
  "paid_configured": true,
  "paid_day_amount": 0.42,
  "paid_daily_budget": 20,
  "paid_day_calls": 7,
  "paid_daily_call_limit": 250
}
```

- [ ] **Step 6: Run all gateway tests**

Run: `npm run gateway:test`

Expected: all tests PASS, including primary-only tests from Plan 1.

- [ ] **Step 7: Commit fallback integration**

```bash
git add workers/wechat-gateway/server.mjs workers/wechat-gateway/atom.mjs workers/wechat-gateway/gateway.test.mjs
git commit -m "feat: add budgeted WeChat fallback"
```

### Task 5: Add a token-protected server scheduler

**Files:**
- Create: `src/lib/server/cron.ts`
- Create: `src/lib/server/cron.test.ts`
- Create: `src/routes/api/cron/tick.ts`
- Modify: `src/lib/server/config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing authorization/time tests**

```ts
// src/lib/server/cron.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCron, reconciliationDue } from "./cron.ts";

test("requires an exact bearer token", () => {
  assert.equal(authorizeCron("Bearer cron-test", "cron-test"), true);
  assert.equal(authorizeCron("Bearer wrong", "cron-test"), false);
});

test("reconciliation becomes due at 23:30 Shanghai", () => {
  assert.equal(reconciliationDue(new Date("2026-08-28T15:29:00Z")), false);
  assert.equal(reconciliationDue(new Date("2026-08-28T15:30:00Z")), true);
});
```

- [ ] **Step 2: Run and verify the missing module**

Run: `node --experimental-strip-types --test src/lib/server/cron.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure cron helpers and config**

Add `authorizeCron` and `reconciliationDue` with no database imports. Append to `prod`:

```ts
cronSecret: read("CRON_SECRET"),
cronTickLimit: Math.max(1, Number(read("CRON_TICK_LIMIT", "200")) || 200),
```

- [ ] **Step 4: Implement the TanStack server route**

Use the official server-route shape:

```ts
// src/routes/api/cron/tick.ts
import { createFileRoute } from "@tanstack/react-router";
import { runSourceJob, tickDueSources } from "@/lib/server/scheduler";
import { runProductionTick } from "@/lib/server/nodes";
import { authorizeCron, reconciliationDue } from "@/lib/server/cron";
import { prod } from "@/lib/server/config";

export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!prod.cronSecret || !authorizeCron(request.headers.get("authorization") ?? "", prod.cronSecret)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const collection = await tickDueSources(prod.cronTickLimit);
        const production = await runProductionTick();
        let reconciliation = null;
        if (reconciliationDue(new Date()) && prod.wechatGatewayUrl && prod.wechatGatewayToken) {
          const response = await fetch(`${prod.wechatGatewayUrl}/v1/reconcile`, {
            method: "POST",
            headers: { Authorization: `Bearer ${prod.wechatGatewayToken}` },
            signal: AbortSignal.timeout(120_000),
          });
          reconciliation = await response.json() as { succeeded_source_ids?: string[] };
          for (const sourceId of reconciliation.succeeded_source_ids ?? []) {
            await runSourceJob(sourceId, "reconcile");
          }
        }
        return Response.json({ collection, production, reconciliation });
      },
    },
  },
});
```

The gateway itself enforces once-per-day reconciliation, so repeated 23:30–23:59 cron calls are safe.

Extend `runSourceJob`'s `kind` union from `"incremental" | "manual"` to `"incremental" | "manual" | "reconcile"`. Each successful reconciliation source is scanned immediately, after the gateway has committed its cached paid items; one source failure must not stop the remaining IDs, so wrap each call and include its result in the returned reconciliation object.

- [ ] **Step 5: Add the test command**

Include `src/lib/server/cron.test.ts` in the TypeScript Node test segment of `npm test`.

- [ ] **Step 6: Run focused and type checks**

Run: `node --experimental-strip-types --test src/lib/server/cron.test.ts`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit the protected route**

```bash
git add src/lib/server/cron.ts src/lib/server/cron.test.ts src/routes/api/cron/tick.ts src/lib/server/config.ts package.json
git commit -m "feat: add protected collection cron route"
```

### Task 6: Run the scheduler continuously in Compose

**Files:**
- Create: `scripts/cron-loop.mjs`
- Create: `scripts/cron-loop.test.mjs`
- Modify: `package.json`
- Modify: `docker-compose.yml`
- Modify: `env.example`
- Modify: `README.md`

- [ ] **Step 1: Write a failing loop contract test**

Export `createCronLoop({ endpoint, secret, intervalMs, fetchImpl, onResult, onError })` without auto-starting during import. With fake timers avoided, test `runOnce()` directly and assert `POST`, `Authorization: Bearer cron-test`, a 120-second timeout signal, and rejection of a non-2xx response.

- [ ] **Step 2: Run and verify the missing module**

Run: `node --test scripts/cron-loop.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the scheduler process**

At process start, require `CRON_ENDPOINT` and `CRON_SECRET`. Run once immediately, then use `setInterval` with `CRON_INTERVAL_MS`, default `1800000`. Prevent overlap with a boolean `running` guard. Log one JSON line per run with timestamp, HTTP status, item count, and error count; never log the secret or response bodies containing secrets.

Add:

```json
"cron:start": "node scripts/cron-loop.mjs"
```

Include `scripts/cron-loop.test.mjs` in `npm test`.

- [ ] **Step 4: Add the Compose service**

```yaml
  scheduler:
    build: .
    command: ["npm", "run", "cron:start"]
    environment:
      CRON_ENDPOINT: http://app:8080/api/cron/tick
      CRON_SECRET: ${CRON_SECRET:-change-cron-secret}
      CRON_INTERVAL_MS: ${CRON_INTERVAL_MS:-1800000}
    depends_on:
      app:
        condition: service_started
    restart: unless-stopped
```

Add to `app.environment`:

```yaml
CRON_SECRET: ${CRON_SECRET:-change-cron-secret}
CRON_TICK_LIMIT: ${CRON_TICK_LIMIT:-200}
```

Add to `wechat-gateway.environment`:

```yaml
DAJIALA_KEY: ${DAJIALA_KEY:-}
DAJIALA_VERIFYCODE: ${DAJIALA_VERIFYCODE:-}
DAJIALA_BASE_URL: ${DAJIALA_BASE_URL:-https://www.dajiala.com/fbmain/monitor/v3}
DAJIALA_DAILY_BUDGET_RMB: ${DAJIALA_DAILY_BUDGET_RMB:-20}
DAJIALA_DAILY_CALL_LIMIT: ${DAJIALA_DAILY_CALL_LIMIT:-250}
```

- [ ] **Step 5: Document runtime values**

Add these names to `env.example` with blank secrets and the defaults above: `CRON_SECRET`, `CRON_INTERVAL_MS`, `CRON_TICK_LIMIT`, `DAJIALA_KEY`, `DAJIALA_VERIFYCODE`, `DAJIALA_BASE_URL`, `DAJIALA_DAILY_BUDGET_RMB`, `DAJIALA_DAILY_CALL_LIMIT`.

In `README.md`, state that 20 RMB is a hard daily ceiling, not a forecast; list-only fallback is 0.06–0.08 RMB per source call and detail enrichment is currently 0.045 RMB per new article according to the provider pages linked above.

- [ ] **Step 6: Run all automated checks**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ /workspace/screenshots/wechat-plan2-dev.png`

Expected: desktop/mobile dev render is clean; visually inspect both screenshots in one batched image read.

Run: `npm run preview:restart`

Expected: built output starts on `127.0.0.1:8081`.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8081/ /workspace/screenshots/wechat-plan2-built.png --baseline /workspace/screenshots/wechat-plan2-dev.json`

Expected: production render is clean and does not diverge from dev.

- [ ] **Step 7: Verify the live scheduling path**

Run: `docker compose up -d postgres wechat-gateway app scheduler`

Expected within three minutes: `scheduler` logs at least one successful JSON result; the app's `jobs` table has a new job for every due source up to the tick limit; a second overlapping loop is skipped rather than duplicated.

Run the deterministic QA fixture from Plan 1 with the primary fixture stopped after its first successful scan. Expected: first failed scan records one failure, second failed scan uses the paid client only when credentials are configured; without credentials the source remains in an explicit degraded state and no paid spend is recorded.

- [ ] **Step 8: Commit operations wiring**

```bash
git add scripts/cron-loop.mjs scripts/cron-loop.test.mjs package.json docker-compose.yml env.example README.md
git commit -m "ops: schedule WeChat collection continuously"
```

## Plan 2 completion gate

Plan 2 is complete when primary success never invokes the paid provider, two primary failures trigger a budget-reserved fallback, required metadata survives detail failure, 23:30 reconciliation is idempotent, the configured daily cap cannot be exceeded under concurrent requests, and collection continues with every browser closed.
