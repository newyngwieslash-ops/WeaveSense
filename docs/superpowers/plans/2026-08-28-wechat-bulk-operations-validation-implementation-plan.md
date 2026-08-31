# WeChat Bulk Operations and Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WeChat collection path operable for 100+ accounts through previewed CSV import, live health/provider visibility, correct multi-provider history, and repeatable 20-account/100-account acceptance reports.

**Architecture:** CSV parsing and validation stay server-side. Import provisions an idempotent deterministic source ID in the gateway before inserting the corresponding Loom source. Gateway batch metadata travels in response headers into job records, while per-article provider history is merged into existing `extra` data on duplicates. The source page reads aggregate gateway health without copying gateway state into PostgreSQL. A report script compares collected rows with a review reference CSV and calculates every approved acceptance metric.

**Tech Stack:** TypeScript, React 19, TanStack Start/Query, Node.js 22, PostgreSQL, built-in SQLite, Node test runner, Docker Compose

**Repository note:** The current workspace is not a Git repository. Execute each `git commit` checkpoint after restoring or initializing repository metadata; until then, run the checks and keep the task boundaries unchanged.

## File map

- Modify `src/lib/wechat-canonical.ts`: deterministic gateway/source IDs.
- Modify `src/lib/wechat-canonical.test.ts`: stable source-ID checks.
- Create `src/lib/server/wechat-import.ts`: RFC 4180 CSV parsing, validation, preview classification.
- Create `src/lib/server/wechat-import.test.ts`: valid/error/duplicate/500-row tests.
- Create `src/lib/server/wechat-gateway-client.ts`: authenticated provision and aggregate-health client.
- Create `src/lib/server/wechat-gateway-client.test.ts`: injected-fetch contract tests.
- Modify `src/lib/server/fns.ts`: preview, confirmed bulk import, and health functions.
- Modify `src/routes/sources.tsx`: CSV mode, preview table, confirmed import, health badges.
- Modify `workers/wechat-gateway/server.mjs`: aggregate health route and response metadata headers.
- Modify `workers/wechat-gateway/gateway.test.mjs`: aggregate health and header checks.
- Create `migrations/0010_wechat_job_provider.sql`: provider/attempt/paid-call job fields.
- Modify `src/lib/server/collectors/types.ts`: batch metadata contract.
- Modify `src/lib/server/collectors/index.ts`: return batches from all adapters.
- Modify `src/lib/server/rss-parser.ts`: parse provider history extensions.
- Modify `workers/wechat-gateway/atom.mjs`: emit provider history extensions.
- Create `src/lib/server/wechat-meta.ts`: provider aggregation and duplicate-history merge.
- Create `src/lib/server/wechat-meta.test.ts`: merge and batch-provider checks.
- Modify `src/lib/server/scheduler.ts`: store batch metadata and merge `providers_seen`.
- Modify `src/lib/server/queries.ts`: map new job fields.
- Modify `src/lib/types.ts`: health and job types.
- Modify `src/routes/jobs.tsx`: provider, attempts, and paid-call display.
- Create `scripts/wechat-validation-lib.mjs`: pure acceptance metrics.
- Create `scripts/wechat-validation-lib.test.mjs`: metric boundary checks.
- Create `scripts/wechat-validation-report.mjs`: database/gateway/reference report command.
- Create `validation/fixtures/reference.csv`: deterministic report fixture.
- Create `validation/fixtures/collected.json`: deterministic collected fixture.
- Create `docs/operations/wechat-pilot-runbook.md`: 20-account, 100-account, restart, and rollback procedure.
- Modify `package.json`: import/metadata/report tests and validation script.
- Modify `README.md`: bulk import and health workflow.

### Task 1: Parse and preview the exact bulk-import contract

**Files:**
- Modify: `src/lib/wechat-canonical.ts`
- Modify: `src/lib/wechat-canonical.test.ts`
- Create: `src/lib/server/wechat-import.ts`
- Create: `src/lib/server/wechat-import.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add failing deterministic source-ID tests**

```ts
test("creates the same safe source id for the same WeChat id", () => {
  assert.equal(wechatSourceId("gh_example"), wechatSourceId(" gh_example "));
  assert.match(wechatSourceId("gh_example"), /^wx-[a-f0-9]{20}$/);
});
```

Implement `wechatSourceId(wechatId)` with the existing SHA-256 helper; lowercase and trim before hashing. Reject an empty ID.

- [ ] **Step 2: Write failing CSV tests**

The required header is exact:

```text
name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority
```

Tests cover:

- quoted commas, escaped double quotes, CRLF, UTF-8 BOM, and a final line without newline;
- missing `name`, `sample_url`, or `primary_feed_url`;
- a sample URL outside `mp.weixin.qq.com`;
- a feed URL outside HTTP/HTTPS;
- `interval_minutes` other than `60`;
- priority defaulting to `normal`, and rejection outside `normal|high`;
- duplicate `wechat_id` inside the CSV;
- duplicate IDs supplied by the existing-source set;
- 500 valid rows in one parse;
- rejection above 1 MiB or 1,000 data rows.

Use this result shape:

```ts
type WechatImportPreview = {
  rows: Array<{
    line: number;
    status: "valid" | "duplicate" | "error";
    errors: string[];
    value?: {
      source_id: string;
      name: string;
      wechat_id: string;
      sample_url: string;
      primary_feed_url: string;
      interval_minutes: 60;
      priority: "normal" | "high";
    };
  }>;
  valid: number;
  duplicate: number;
  error: number;
};
```

- [ ] **Step 3: Verify missing behavior**

Run: `node --experimental-strip-types --test src/lib/wechat-canonical.test.ts src/lib/server/wechat-import.test.ts`

Expected: FAIL on missing exports/modules.

- [ ] **Step 4: Implement one RFC 4180 state machine**

Implement `parseCsvRecords(text)` with four states only: field, quoted field, quote-after-quote, and record end. Do not add a dependency. Then implement `previewWechatImport(csv, existingWechatIds)` as validation over parsed records.

Add a `ponytail:` comment above the 1,000-row ceiling explaining that streaming CSV parsing is the upgrade path if imports grow beyond the in-memory 1 MiB/1,000-row boundary.

- [ ] **Step 5: Add focused tests to `npm test` and run them**

Run: `node --experimental-strip-types --test src/lib/wechat-canonical.test.ts src/lib/server/wechat-import.test.ts`

Expected: all tests PASS, including the 500-row case.

Run: `npm test`

Expected: all project tests PASS.

- [ ] **Step 6: Commit parsing and preview logic**

```bash
git add src/lib/wechat-canonical.ts src/lib/wechat-canonical.test.ts src/lib/server/wechat-import.ts src/lib/server/wechat-import.test.ts package.json
git commit -m "feat: validate bulk WeChat source imports"
```

### Task 2: Provision the gateway before inserting Loom sources

**Files:**
- Create: `src/lib/server/wechat-gateway-client.ts`
- Create: `src/lib/server/wechat-gateway-client.test.ts`
- Modify: `src/lib/server/fns.ts`

- [ ] **Step 1: Write failing gateway-client tests**

`createWechatGatewayClient({ baseUrl, token, fetchImpl })` must expose:

```ts
{
  putSource(source),
  listHealth(),
}
```

Test that `putSource` sends `PUT /v1/sources/{source_id}` with bearer auth and this body:

```json
{
  "name": "示例号",
  "account_id": "gh_example",
  "priority": "normal",
  "sample_url": "https://mp.weixin.qq.com/s/example",
  "primary_feed_url": "https://feeds.example.com/example.atom"
}
```

Test timeout, 401, 422, invalid JSON, and sanitized error behavior. `listHealth` sends `GET /v1/health` with the same auth.

- [ ] **Step 2: Run and verify missing client behavior**

Run: `node --experimental-strip-types --test src/lib/server/wechat-gateway-client.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the client with injected fetch**

Use `AbortSignal.timeout(20_000)` for provisioning and 30 seconds for aggregate health. Never expose the token through errors or return values. The production wrapper reads `prod.wechatGatewayUrl` and `prod.wechatGatewayToken` only when a function is called.

- [ ] **Step 4: Add preview and confirmed-import server functions**

Add `previewWechatImportFn` as a POST server function accepting `{ csv: string }`; query existing WeChat handles and return `WechatImportPreview`. Add `importWechatSourcesFn` as a POST server function accepting `{ csv: string; confirmed_lines: number[] }`; re-parse the original CSV, provision the selected valid rows, and insert successful mappings.

The confirmed import must re-run all validation server-side. For each confirmed valid row, in order:

1. check PostgreSQL again for `platform='wechat' AND lower(handle)=lower(wechat_id)`;
2. call the idempotent gateway PUT using `source_id`;
3. only after HTTP 200, insert the Loom source with `platform='wechat'`, `adapter='wechat_gateway'`, `handle=wechat_id`, `url=sample_url`, `feed_url=''`, `interval_minutes=60`, and `notes='priority:' || priority`;
4. continue after an individual failure and return `{ created, skipped, failed: [{ line, name, error }] }`.

Provisioning happens before the database insert, as approved. The deterministic ID makes a retry safe if the gateway succeeded but the database write failed.

- [ ] **Step 5: Run server checks**

Run: `node --experimental-strip-types --test src/lib/server/wechat-gateway-client.test.ts src/lib/server/wechat-import.test.ts`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit bulk provisioning**

```bash
git add src/lib/server/wechat-gateway-client.ts src/lib/server/wechat-gateway-client.test.ts src/lib/server/fns.ts
git commit -m "feat: provision WeChat sources in bulk"
```

### Task 3: Add CSV preview and confirmation to the source page

**Files:**
- Modify: `src/routes/sources.tsx`
- Modify: `README.md`

- [ ] **Step 1: Add a WeChat CSV mode to the existing dialog**

When `platform === "wechat"`, show two tabs: `单个` and `CSV 批量`. The CSV tab contains a file input accepting `.csv`, a paste textarea, and a `预览` button. Read at most 1 MiB using `file.text()` and call `previewWechatImportFn`.

- [ ] **Step 2: Render the preview before any write**

Show counts for valid/duplicate/error and a horizontally scrollable table with line, name, WeChat ID, priority, and error. Check only valid rows by default. Disable `确认导入` until preview exists and at least one valid row is selected.

Accessibility requirements:

- the tabs use buttons with `aria-pressed`;
- the modal retains the existing close button and form semantics;
- validation text is visible, not color-only;
- the table container scrolls on 390 px screens instead of widening the page;
- the confirm button announces `确认导入 N 个公众号`.

- [ ] **Step 3: Confirm only previewed rows**

Call `importWechatSourcesFn` with the original CSV plus selected line numbers. Show a summary toast for created/skipped and a persistent error list for failed rows. Invalidate `sources`, `overview`, and `wechat-health` queries after success.

- [ ] **Step 4: Document the CSV format**

Add the exact header, one non-secret example row, validation rules, 500-row guarantee, and gateway-before-database behavior to `README.md`.

- [ ] **Step 5: Run UI gates**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ /workspace/screenshots/wechat-import-dev.png`

Expected: desktop and mobile render, no horizontal page overflow, and no console errors. Visually inspect both generated screenshots in one batched image read. Manually exercise the fixture CSV preview without confirming external writes; counts and row errors must match the parser tests.

- [ ] **Step 6: Commit the bulk UI**

```bash
git add src/routes/sources.tsx README.md
git commit -m "feat: preview and import WeChat source CSV"
```

### Task 4: Expose provider attempts, paid calls, and health without duplicating state

**Files:**
- Modify: `workers/wechat-gateway/server.mjs`
- Modify: `workers/wechat-gateway/atom.mjs`
- Modify: `workers/wechat-gateway/gateway.test.mjs`
- Create: `migrations/0010_wechat_job_provider.sql`
- Modify: `src/lib/server/collectors/types.ts`
- Modify: `src/lib/server/collectors/index.ts`
- Modify: `src/lib/server/rss-parser.ts`
- Create: `src/lib/server/wechat-meta.ts`
- Create: `src/lib/server/wechat-meta.test.ts`
- Modify: `src/lib/server/scheduler.ts`
- Modify: `src/lib/server/queries.ts`
- Modify: `src/lib/server/fns.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/routes/sources.tsx`
- Modify: `src/routes/jobs.tsx`

- [ ] **Step 1: Write failing gateway observability tests**

Assert `GET /v1/health` requires bearer auth and returns `{ sources, usage, limits }`. Each source includes last primary success, consecutive failures, recent error type, last paid time/result, current alert state, and next retry. Usage includes today's call count and RMB amount.

Assert feed responses include:

```text
X-Loom-Provider: primary | dajiala | mixed
X-Loom-Attempts: primary | primary,dajiala
X-Loom-Paid-Call: true | false
```

Also emit per-entry `<loom:providers_seen>` as a comma-separated value.

- [ ] **Step 2: Add the main-database migration**

```sql
-- migrations/0010_wechat_job_provider.sql
alter table jobs add column if not exists provider text not null default '';
alter table jobs add column if not exists attempts jsonb not null default '[]'::jsonb;
alter table jobs add column if not exists paid_call boolean not null default false;
```

- [ ] **Step 3: Introduce a batch result at the collector boundary**

Change the type once at the shared boundary:

```ts
export type CollectorBatch = {
  items: NormalizedItem[];
  meta: {
    provider: "" | "primary" | "dajiala" | "mixed";
    attempts: string[];
    paid_call: boolean;
  };
};

export type CollectorAdapter = {
  id: string;
  fetch(source: SourceRecord): Promise<CollectorBatch>;
};
```

Wrap existing RSS, Telegram, YouTube, Bilibili, and RSSHub arrays as `{ items, meta: { provider: "", attempts: [adapter.id], paid_call: false } }`. The WeChat gateway adapter fills meta from the three response headers. This shared change is required so an empty paid result is still recorded accurately in `jobs`.

- [ ] **Step 4: Add pure provider-history helpers and tests**

`wechat-meta.ts` exports:

```ts
providerFromItems(items): "" | "primary" | "dajiala" | "mixed";
mergeProvidersSeen(existingExtra, incomingProvider): Record<string, unknown>;
```

Tests prove order-preserving uniqueness: `primary + dajiala + primary` becomes `['primary', 'dajiala']`, and unrelated `extra` keys survive.

- [ ] **Step 5: Persist batch metadata and merge duplicates**

In `runSourceJob`, use `const { items: fetched, meta } = await collectSource(record)`. On job success and failure, write `provider`, `attempts`, and `paid_call`.

Before filtering fresh items, select existing `id`, `external_id`, `url`, and `extra`. For a matching canonical ID or normalized URL, update only `extra.providers_seen`; never overwrite an already stored non-empty body or cover with an empty fallback value. Fresh items store `providers_seen` beginning with the current item provider.

- [ ] **Step 6: Read aggregate health through a server function**

Add `listWechatHealthFn` that calls `GET /v1/health`. If the gateway is unconfigured or unavailable, return `{ available: false, error, sources: [], usage: null }` instead of failing the entire source page. Do not insert health rows into PostgreSQL.

Add matching `WechatHealthRow`, `WechatHealthOverview`, and new `JobRow` fields in `src/lib/types.ts`; map the new job fields in `queries.ts`.

- [ ] **Step 7: Render health and job metadata**

On `sources.tsx`, query health only when at least one WeChat source exists. Match by `source_id` and show:

- `正常`, `降级`, `付费兜底`, or `告警` badge;
- latest primary success and failure count;
- latest paid check/result;
- today's calls and spend once in the WeChat section header;
- an explicit unavailable message when the gateway cannot be reached.

On `jobs.tsx`, add provider, ordered attempts, and a `付费` badge. Preserve the mobile stacked layout rather than forcing a wide table.

- [ ] **Step 8: Run migration and all checks**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ /workspace/screenshots/wechat-health-dev.png`

Expected: source and job pages render on desktop/mobile with no uncaught errors.

- [ ] **Step 9: Commit observability**

```bash
git add workers/wechat-gateway/server.mjs workers/wechat-gateway/atom.mjs workers/wechat-gateway/gateway.test.mjs migrations/0010_wechat_job_provider.sql src/lib/server/collectors/types.ts src/lib/server/collectors/index.ts src/lib/server/rss-parser.ts src/lib/server/wechat-meta.ts src/lib/server/wechat-meta.test.ts src/lib/server/scheduler.ts src/lib/server/queries.ts src/lib/server/fns.ts src/lib/types.ts src/routes/sources.tsx src/routes/jobs.tsx
git commit -m "feat: expose WeChat provider health and attempts"
```

### Task 5: Build an acceptance report and staged operations runbook

**Files:**
- Create: `scripts/wechat-validation-lib.mjs`
- Create: `scripts/wechat-validation-lib.test.mjs`
- Create: `scripts/wechat-validation-report.mjs`
- Create: `validation/fixtures/reference.csv`
- Create: `validation/fixtures/collected.json`
- Create: `docs/operations/wechat-pilot-runbook.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing metric tests**

The pure library accepts reference articles, collected articles, health rows, and usage. Test exact pass/fail boundaries for:

- required-field validity `>= 99%`;
- discovery within two hours `>= 95%`;
- provider-known same-day missing articles equal `0`;
- duplicate rate `< 0.1%`;
- body coverage `>= 80%`;
- cover coverage `>= 90%`;
- every source without a success for 24 hours appears in alert state;
- paid calls and RMB amount stay at or below configured caps.

Use `canonical_id` first and normalized URL second when matching the two datasets.

- [ ] **Step 2: Create deterministic fixtures**

`validation/fixtures/reference.csv` contains ten fake `mp.weixin.qq.com` articles across three fake accounts. `collected.json` contains matching rows at the metric boundaries plus health and usage. No real account names, credentials, or provider responses belong in fixtures.

- [ ] **Step 3: Run and verify missing implementation**

Run: `node --test scripts/wechat-validation-lib.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement the metric library and report command**

Add:

```json
"wechat:report": "node scripts/wechat-validation-report.mjs"
```

The command requires:

```text
--reference <csv-path>
--database-url <postgres-url>
--gateway-url <internal-url>
--gateway-token-env WECHAT_GATEWAY_TOKEN
--from <ISO timestamp>
--to <ISO timestamp>
--out <json-path>
```

The gateway token is read from the named environment variable, never the command line or report. Query only `platform='wechat'` items/jobs in the requested interval and call aggregate gateway health. Write JSON with raw counts, percentages, configured thresholds, pass/fail per metric, total paid usage, and an overall result. Exit 0 only when every metric passes; exit 1 for metric failure; exit 2 for invalid input or unavailable data.

- [ ] **Step 5: Test the report with fixtures**

Expose `--collected-fixture validation/fixtures/collected.json` for offline tests; it is mutually exclusive with database/gateway arguments.

Run: `npm run wechat:report -- --reference validation/fixtures/reference.csv --collected-fixture validation/fixtures/collected.json --out validation/fixtures/report.json`

Expected: report is written, contains every metric, and exits with the expected fixture result asserted by the test.

- [ ] **Step 6: Write the staged runbook**

The runbook has these exact gates:

1. import 10–20 approved public accounts and run 72 hours with the provider trial;
2. maintain `validation/wechat-reference.csv` from manual review plus the provider's daily result;
3. generate one report for each 24-hour window and one aggregate 72-hour report;
4. stop provider purchase and test 清博 only if required-field validity is below 99% or provider-known same-day misses remain;
5. if pilot passes, import 100+ accounts and run seven days;
6. restart `wechat-gateway`, `scheduler`, and `app` once during the week, then verify SQLite/PostgreSQL persistence and no duplicate spike;
7. reject production migration if any daily budget is exceeded, any 24-hour outage is absent from alerts, or the seven-day aggregate fails;
8. after pass, move the unchanged Compose stack and persistent volumes to the fixed-egress Docker server.

External inputs are explicitly gated: the pilot cannot begin until the approved account CSV and provider trial credentials exist. Automated fixture tests and UI work do not wait on those credentials.

- [ ] **Step 7: Run the complete quality suite**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ /workspace/screenshots/wechat-final-dev.png`

Expected: clean desktop/mobile dev verdict and no browser console errors. Visually inspect `/workspace/screenshots/wechat-final-dev.png` and `/workspace/screenshots/wechat-final-dev-mobile.png` in one batched image read.

Run: `npm run preview:restart`

Expected: production preview starts successfully.

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8081/ /workspace/screenshots/wechat-final-built.png --baseline /workspace/screenshots/wechat-final-dev.json`

Expected: production verdict does not diverge from dev.

- [ ] **Step 8: Commit validation tooling**

```bash
git add scripts/wechat-validation-lib.mjs scripts/wechat-validation-lib.test.mjs scripts/wechat-validation-report.mjs validation/fixtures docs/operations/wechat-pilot-runbook.md package.json
git commit -m "test: add WeChat scale acceptance report"
```

## Plan 3 completion gate

Plan 3 implementation is complete when a 500-row CSV previews before writing, confirmed rows provision gateway-first, source health remains live from the gateway, empty and non-empty jobs retain actual provider attempts, duplicate articles accumulate provider history without losing content, and the fixture acceptance report is deterministic. Product validation is complete only after the 20-account/72-hour and 100+-account/seven-day gates in the runbook pass with real approved public-account data.
