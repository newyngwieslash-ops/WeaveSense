# Agent capability baseline — 2026-10-07

This is a verification record for the shared working tree, not a claim that the
uploaded archive, deployed application, or live model chain was tested. Other
agents were changing the implementation concurrently. No commit was made by this
verification lane, and none of their changes were reverted.

## Environment and boundaries

- Working tree: `F:/AI_WeaveSence_Things/WeaveSense`.
- HEAD: `24d899023db08c8ea2e739b9c77a150743cc8bf6`.
- Host: Windows; Node `v22.22.3`; npm `10.9.8`; Go `go1.25.7 windows/amd64`.
- `workers/agent/go.mod` requires Go `1.24.1`; the installed compiler is newer.
- Docker daemon version `28.5.2` was confirmed by a read-only `docker info` after
  sandbox access to its named pipe was denied and bounded elevated access granted.
- Dependencies were already installed by the coordinating lane. This lane did not
  modify `package.json`, `package-lock.json`, install dependencies, or run `npm ci`.
- Shell flags `AI_ENGINE`, `AGENT_ASYNC_RESEARCH_ENABLED`, `AGENT_WORKER_ENABLED`,
  `AGENT_RESEARCH_RUNTIME`, and `AGENT_RESEARCH_REVIEW` were unset. Checked Compose
  defaults use `AI_ENGINE=legacy`, async research disabled, and the Go agent behind
  the optional `agent` profile. These defaults do not prove a running deployment's
  effective configuration. No provider keys or credential values were printed.

At lane start the working tree already contained changes to Compose, lockfile,
Agent TS/Go implementation, and untracked plans, reports, tests, and `.omx/` state.
Those belong to other work. This lane owns only the cleanup plan, this record,
`eslint.config.mjs`, the existing Telegram/model configuration tests, and the
equivalent regex spelling in `scripts/service-env-least-privilege.test.mjs`.

## Baseline problems and behavior-preserving repairs

The cleanup plan was saved before editing code:
`.omx/plans/verification-baseline-cleanup.md`.

- Initial typecheck: 7 diagnostics in `collectors/telegram.test.mjs` (untyped
  test input/URL list and unknown caught errors). Added JSDoc-only types; retained
  the existing fake transports, assertions, scenarios, and cleanup.
- Initial ESLint: 382 errors / 44 warnings over 259 files. Of the errors, 380
  came from the vendored compressed Comet router, one was a never-reassigned `let`
  in the model test, and one was two literal regex spaces in the service-env test.
- Ignored only `.agents/skills/comet/scripts/**` (vendored local bundle) and
  `.omx/**` (generated orchestration state). No application/test rule was disabled,
  and no business-source directory was excluded.
- Changed the model test's local `let` to `const`; rewrote two literal regex spaces
  as ` {2}`. Existing tests serve as regression protection; no redundant new tests
  were introduced for these mechanical changes.

## Verification results

| Command | Result | Meaning |
|---|---|---|
| `npm run typecheck` | Exit 0 | Full TypeScript check after the JSDoc repair |
| `npm run lint -- --format json --output-file .omx/lint-baseline-after.json` | Exit 0; 0 errors, 18 warnings, 258 files | Full configured lint; existing warnings remain visible |
| `node src/lib/server/collectors/telegram.test.mjs` | Exit 0; 3 passed, 0 failed/skipped | Existing authorized failure/FloodWait/fallback tests |
| `node --experimental-strip-types src/lib/server/model-config.test.ts` | Exit 0; 4 passed, 0 failed/skipped | Existing profiles, file access and mocked connection tests |
| `node scripts/service-env-least-privilege.test.mjs` | Exit 0; 5 passed, 0 failed/skipped | Existing credential-layout guards; no service calls |
| `npm test` in the default sandbox | Exit 1; first 10 file workers rejected with `spawn EPERM` | Environment failure, not counted as product test failures or passes |
| `npm test` with approved child-process access | Exit 0; 410 passed, 0 failed/cancelled/skipped | All four configured groups completed: 73 + 21 + 291 + 25 tests; the third group includes 17 suites |
| `git diff --check` on the four owned code files | Exit 0 | No whitespace errors |

Machine-local detailed diagnostics are in `.omx/lint-baseline-before.json`,
`.omx/lint-baseline-after.json`, `.omx/npm-test-baseline.log`, and
`.omx/npm-test-baseline-approved.log`. They are generated verification state,
not application source or proof of a pristine checkout.

The full `npm test` completed at approximately 12:45 +08:00 on 2026-10-07.
Its four group durations were 8.197 s, 180.518 s, 54.040 s, and 15.399 s.
The command used the package script as it existed when launched; tests added by
other lanes later are not automatically covered by this completed run. The three
explicit affected-file runs above are reported separately, not added to the 410
count to imply additional unique suite coverage.

## Isolated migration and failure verification — 13:06 +08:00

The later Task 7/16 verification lane added `migrations.test.ts` and
`faults.test.ts` under this directory. HEAD remained the value recorded above;
the application implementation continued changing in the shared working tree.
These results cover the function boundaries on disk at test execution, not an
end-to-end worker or browser run.

- Disposable PostgreSQL `16.14`, image `postgres:16-alpine`, container
  `loom-opencode-validation-20261007-audit`, label
  `weavesense.validation=agent-opencode`, bound only to `127.0.0.1:53085`.
  Each test creates and drops its own randomly named schema. Tests verify the
  container label and exact loopback mapping before connecting; no deployment
  database or host configuration was used. The coordinating lane requested that
  this test container remain available for later integration validation.
- `node --experimental-strip-types validation/agent/opencode/faults.test.ts`:
  exit 0, **8 passed / 0 failed / 0 skipped**, 9.231 s. Real independent PG
  connections wait on confirmed database locks before competing: immutable
  candidate insertion; stable review call/grant; exactly one `send_once` result;
  unknown-call replay refuses another send; completed-review publication retry
  after a discarded acknowledgement creates only one note; source changes and
  changed claims observed after lock waits reject publication; cancellation
  rejects publication; injected completion failure rolls back note/run changes;
  one remaining daily allowance admits one job; injected reservation failure
  leaves no partial job, reservation, admission gate, or daily budget.
- `node --experimental-strip-types validation/agent/opencode/migrations.test.ts`:
  exit 0, **2 passed / 0 failed / 0 skipped**, 3.716 s. PGlite exercises the
  actual `src/lib/db.ts` runner through Vite and a second fresh HMR module;
  PostgreSQL exercises the actual `scripts/migrate.mjs` subprocess. Both start
  from migration 21 with existing note/run/model-call rows, intentionally fail
  conflicting migration 23 backfill, assert its DDL and migration record roll
  back, repair the test fixture, then apply 22/23/24 and repeat the runner.
  Existing notes/runs are preserved; old calls become producer calls with null
  request digests; repeat execution leaves migration timestamps unchanged.
- Commands use `REVIEW_PG_PORT=53085` and
  `REVIEW_PG_CONTAINER=loom-opencode-validation-20261007-audit`. Missing or
  inaccessible PG is a failing `postgres_not_covered` precondition, never a
  skipped test counted as a pass. Approved process access was needed for Docker,
  Vite's transform process, and the real migration subprocess.
- Scoped ESLint and `git diff --check`: exit 0. These ten new tests are separate
  from the earlier 410-test package run; they were not silently added to its count.
- Fault injection deliberately produced the expected rejection/rollback states.
  The new assertions passed on the current implementation; no failing business
  assertion was suppressed or changed to make the suite green.

The subsequent `e2e.mjs` preparation is separate:
`node validation/agent/opencode/e2e.mjs --check` from the repository root passes
five local fake-response contract assertions and
reports `browser: not_run`, `runtime: not_run`. Node syntax check and scoped
ESLint also pass. At that preparation checkpoint no app, worker, or browser had
been started by this script. Its explicit `--run` entry creates a fresh schema inside
the same labeled disposable container, use only a local fake model endpoint,
and write browser screenshots below the repository `screenshots/` directory.
The ignored `.repo/opencode-validation-pg.json` contains only the disposable
test connection for the coordinating lane; no production credentials are used.

## Limits of the initial baseline (later integration results below)

- No paid model calls or live A/B/C quality/latency/cost comparison.
- No application build or deployment-database migration. The isolated migrations
  above exercise test databases only; the normal build invokes migrations.
- No browser render validation or authenticated deployment check.
- No Go-suite result claimed here; the Go implementation owner runs those checks.
- The existing integration harness was read and Docker availability confirmed.
  It creates a labeled isolated PostgreSQL container, fake model/MCP services, and
  browser sessions. This lane did not start it while other lanes modify its
  contracts; coordinating integration verification remains required.
- ESLint has 18 existing warnings. Exit 0 does not mean warning-free code.

Offline review fixtures separately validate contracts and scoring; they are not
evidence that Eino, OpenCode, or an independent Reviewer improved answer quality.

Go ModelProxy integration (2026-10-07T05:23:05.292Z): actual pinned Linux OpenCode completed 3 admitted model sends and 2 corpus tools through the production Go bridge. Natural SDK max_tokens was 1800 on every send; exact bounded request digests and completed usage receipts matched the fake ledger. Runtime vendor bypass/public egress were denied; no vendor/app credentials, host binds or published ports existed in runtime. Labelled test resources were removed. Paid requests: 0. This covers fake-ledger integration only, not real-DB end-to-end publication or model quality.

Go ModelProxy integration (2026-10-07T05:25:02.012Z): actual pinned Linux OpenCode completed 3 admitted model sends and 2 corpus tools through the production Go bridge. Natural SDK max_tokens was 1800 on every send; exact bounded request digests and completed usage receipts matched the fake ledger. Runtime vendor bypass/public egress were denied; no vendor/app credentials, host binds or published ports existed in runtime. Labelled test resources were removed. Paid requests: 0. This covers fake-ledger integration only, not real-DB end-to-end publication or model quality.

## Real application and PostgreSQL browser chain — Eino

`e2e.mjs --run` and `e2e.mjs --run --built` now run the actual application,
Go worker/independent Reviewer, PostgreSQL migrations and governance ledger,
with an authored loopback-only model server. `AI_ENGINE=legacy` alongside
`AGENT_RESEARCH_RUNTIME=eino` confirms the independent research selector.
Each run has its own schema; build-time `DATABASE_URL` points only at that schema.
No production database is accessed. The existing Linux `startup.sh` was read
and retained; this Windows harness launches the existing `npm run dev` /
`npm run preview` scripts through `with-app-env.mjs` on its own loopback ports.

Verified scenarios: browser queue and refresh, immutable candidate, an independent
two-message/no-tool review, one reviewed published note, a blocking review with
visible unpublished draft/findings, queued cancellation with no model send, and
running cancellation that revokes authority and never publishes. Each complete
Eino run observed five local fake requests (three Producer, two Reviewer across
the scenarios), zero paid calls. Desktop/mobile scenario screenshots were viewed
and found readable, with no horizontal overflow or browser console/page errors.

The current Playwright package's Chromium revision is absent on this host;
`PLAYWRIGHT_CHANNEL=msedge` explicitly uses installed Edge with ephemeral profiles.
The checked-in `browser-smoke.mjs` wrapper preserves the project smoke script and
waits for the test's published heading before screenshotting, so an unhydrated
shell is not compared with a populated production page. The final strict smoke
comparison reports `divergesFromBaseline: false`, `baselineReasons: []`, zero
console/page errors and no overflow on both viewports. The script's informational
`BRAND NOTE` says this CRUD/admin-style knowledge utility uses the platform card;
it is not a custom-card render failure.

Evidence checkpoints (machine-local `.repo/` JSON and logs, not a clean checkout):

- Initial full dev functional pass: `opencode-e2e-af253e1a-b8b1-44ae-8fd4-2e83cdc45bb5`.
- Initial built failure: `opencode-e2e-09beda12-a5ce-4322-a66a-f3ec294bd67d`;
  build exited 0, preview returned 500 with undefined `ssr_exports`. The build
  owner fixed Nitro's second bundling pass; failures were not counted as passes.
- Stable dev plus hydrated standard smoke: `opencode-e2e-c3710a94-d844-4efb-af59-8e0eee24ef30`.
- Built plus strict dev comparison: `opencode-e2e-1b4ad3ab-166c-4e19-a285-8ab4d9ecb4a6`.

Some cold development starts reported a dynamic-module load error during Vite's
first dependency optimization. Those failed attempts are retained. The harness
now records a separate bounded development warmup and requires a fresh context
to pass cleanly; the latest warmup recorded no errors. Production has no warmup
exception. The migration test also uses its own Vite cache directory to avoid
interfering with a live dev server. Neither limitation is evidence of model
quality. Final native OpenCode integration and any later source changes require
their own verification; Eino success is not substituted for them.

After migration 25 was added, both real migration runners were rechecked:
2 passed, 0 failed/skipped, 4.865 s. The new migration is included automatically.
After isolating the migration-test Vite cache, the final rerun also passed both
tests (3.970 s, zero failed/skipped), after all browser/build work completed.

## Native OpenCode with the real application ledger — final integration

Both `e2e.mjs --run --opencode` and `e2e.mjs --run --built --opencode` passed.
The final production build includes the host tool-count correction and Go's
non-nil empty-evidence response correction. `e2e.fixture.json` records compact
non-secret results; complete local logs are in:

- Dev: `.repo/opencode-e2e-d69036b9-0962-4039-b15e-2ad0018645e4/`.
- Final built: `.repo/opencode-e2e-3f524fe1-2fc2-43a4-8339-d9bbe8296469/`.
- Earlier native failure: `.repo/opencode-e2e-6d274d96-8149-4e65-8567-deebdd245ea7/`.
  Three model and two corpus calls succeeded, but the Go empty evidence array
  was omitted, so strict TS candidate admission returned 400. The shared Go
  contract was fixed with a red/green regression; the harness assertion was
  retained, and the real chain then passed.

This uses the actual TypeScript app's `opencode-jobs`, `agent-data`, and
`agent-review` handlers, actual PostgreSQL tables, current-source Go control
worker and bridge, pinned Linux OpenCode 1.3.13, and the same Go independent
Reviewer as Eino. The published scenario has three completed Producer calls,
one completed Reviewer call, and two completed corpus tools in the actual DB.
Each fake reply's usage is 100 input / 20 output tokens; the reservation settles
to `0.0000056` at authored fixture rates. These numbers verify arithmetic, not
real provider cost. The final build asserts both `ai_runs.tool_calls` and
`response_json.runtime.tool_calls` equal the authoritative tool-row count of 2.
One immutable candidate and exactly one published note are present.

Blocking review, retained draft/findings, queued cancellation without a model
send, and running cancellation with revoked grants/no publication also pass.
Nine local fake model sends occur across all native scenarios; paid requests
are **0**. Streamed Producer responses include terminal usage and `[DONE]`;
persisted completed receipts are checked against the observed model sends.
Denied model/tool calls after cancellation remain visible as expected 403s.

The untrusted runtime has only its internal isolated network, read-only root,
no host binds, no published ports, and no supplier/app credentials. Real socket
probes allow the trusted bridge and reject direct host vendor access, direct
host app access, and public egress. Only the trusted services can reach the
owned Windows loopback app/fake server via Docker Desktop's host gateway.
No host service had to bind a public interface.

Desktop/mobile native dev and built screenshots were displayed and inspected:
drafts, blocking findings and published notes remain distinct and readable.
The standard smoke checks have zero console/page errors, no horizontal overflow,
and production comparison `divergesFromBaseline: false`. The final generated
server entry also passes `node --check`; the build's migration runner reports
up to date against its isolated schema. Production's first browser context passes.

All full-chain test containers/networks and per-run schemas were checked absent
after cleanup. Only the explicitly retained test PostgreSQL container and local
Docker image caches remain. This proves fake-only protocol, persistence and
browser behavior; live model quality, actual paid cost and deployment-host
isolation remain separate adoption gates.

Operations documentation check (2026-10-07): the new optional-research runbook was checked against current Compose profiles, config readers, worker cleanup/recovery, queue/provider guards, pricing/Skill freezing and runtime-lock evidence. It explicitly requires the separate agent Reviewer profile, notes that service_started is not readiness, and keeps live quality/deployment-host validation pending. The bridge model timeout now uses the same AGENT_MODEL_TIMEOUT_MS field as the Reviewer. No production deployment, paid call, provider-switch rehearsal or production rollback was executed by this documentation lane; the described recovery commands are operator instructions, not passing evidence.

## Current Linux concurrency verification — 2026-10-07

The current Go sources (including empty-evidence wire serialization) passed
`go test -race -json -count=1 -timeout=5m ./internal/agent ./internal/opencode`
in Go 1.25.7 Linux/amd64 with GCC 12.2.0, using the pinned official Go image
recorded in `race.fixture.json`. There were 102 top-level tests / 203 results
including subtests, 0 failures, 0 skips and 0 DATA RACE reports. Agent elapsed
15.843 s, OpenCode 3.208 s; compilation and tests took 56.605 s.

This trusted test container had no network, no production environment, dropped
all capabilities and used no-new-privileges. It used only fake model/HTTP endpoints.
The first attempt omitted the existing JSON contract fixtures and failed two
fixture-loading tests; adding those files to the test image and rerunning the
entire command produced the recorded pass. No business assertions were weakened.
The validation container and its own temporary tag were removed. This does not
establish quality, cost or latency of a real model.

## Final release verification — 2026-10-07

The final `npm test` exit code is 0: six groups contain 75, 21, 296, 25, 31
and 41 passing tests (489 total), with zero failures, cancellations or skips.
The final run includes the real-driver preflight tests and authoritative
OpenCode tool-count regression. Local output: `.repo/release-agent-tests.log`.
`npm run typecheck` exits 0. `npm run lint` exits 0 with 14 warnings and zero
errors; generated `.repo/` build copies are excluded, matching their existing
Git exclusion. Current-source Go `test ./... -count=1` and `vet ./...` also
exit 0; logs are `.repo/final-agent-go.log` and `.repo/final-agent-go-vet.log`.

The concrete evaluation adapter's A/B smoke passed against independently
labelled Docker app/PG/Eino services and the existing built output. It checks
real enqueue, persistence, independent review and publication with three local
fake sends and zero paid calls. Both observations verify their frozen conditions,
settle their fixture costs and have no duplicate execution. The first attempt
was refused before model sends because the harness lacked explicit network
aliases; fixing only that harness setup produced the passing rerun. Compact
non-secret evidence is `live-adapter-smoke.fixture.json`; local details are
`.repo/live-adapter-smoke-4d6bfd7a-7975-4493-9342-f12ff926cbac/verdict.json`.
This is one authored question, not a quality comparison or adoption decision.

Go ModelProxy integration (2026-10-07T08:45:52.901Z): actual pinned Linux OpenCode completed 3 admitted model sends and 2 corpus tools through the production Go bridge. Natural SDK max_tokens was 1800 on every send; exact bounded request digests and completed usage receipts matched the fake ledger. Runtime vendor bypass/public egress were denied; no vendor/app credentials, host binds or published ports existed in runtime. Labelled test resources were removed. Paid requests: 0. This covers fake-ledger integration only, not real-DB end-to-end publication or model quality.

Go ModelProxy integration (2026-10-07T08:49:54.511Z): actual pinned Linux OpenCode completed 3 admitted model sends and 2 corpus tools through the production Go bridge. Natural SDK max_tokens was 1800 on every send; exact bounded request digests and completed usage receipts matched the fake ledger. Runtime vendor bypass/public egress were denied; no vendor/app credentials, host binds or published ports existed in runtime. Labelled test resources were removed. Paid requests: 0. This covers fake-ledger integration only, not real-DB end-to-end publication or model quality.
