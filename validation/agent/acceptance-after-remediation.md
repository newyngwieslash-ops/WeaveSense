# Eino Agent follow-up acceptance — 2026-09-08

Current status: [V3 implementation acceptance](implementation-v3-2026-09-08/acceptance.md) supersedes the historical open-item status below. It includes V1–V10, original 20 tasks, C1–C12 mapping, real isolated PostgreSQL races, dev/built Agent browser integration and Linux race evidence. Real paid/production checks remain pending authorization; no production features were enabled.

## Workspace

- HEAD: `76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9`; all Agent remediation remains **uncommitted**.
- Git metadata: `.repo`; no commit, push, reset, clean, deployment, production database, paid model, or external MCP call was performed.
- `restart.bat` was pre-existing user work and was not edited in this session.

## Passed offline evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| Legacy regression | `node --experimental-strip-types --test validation/agent/review-2026-09-08/repro.test.ts` | R01–R09: 9/9 passed |
| Follow-up business regressions | `node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/spec-repro.test.ts` | S01–S08: 8/8 passed |
| Material caps | `node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/material-repro.test.ts` | M01–M02: 2/2 passed |
| Go follow-up probes | `CGO_ENABLED=0 GOTOOLCHAIN=local go -C workers/agent test -overlay ../../validation/agent/review-followup-2026-09-08/go-overlay.json ./internal/agent -run TestFollowup -v -count=1` | 7 functions / 8 observations passed |
| Formal Go regression | `CGO_ENABLED=0 GOTOOLCHAIN=local go -C workers/agent test ./... -count=1` | passed; the follow-up probe is now `internal/agent/followup_regression_test.go` |
| Node suite | `npm test` | passed; package test now also runs R01–R09, S01–S08, M01–M02 |
| Types / vet | `npm run typecheck`; `go -C workers/agent vet ./...` | both passed |
| Production build | `npm run build` | passed after Windows-safe local Vite launch fix; migration reports no `DATABASE_URL`, so isolated PGlite fallback is the exercised path |
| Dev browser | `node scripts/browser-smoke.mjs http://127.0.0.1:8080/knowledge screenshots/agent-dev.png` | desktop + 390×844 mobile: HTTP 200, visible content, no console/page error, no horizontal overflow. Screenshots: `screenshots/agent-dev.png`, `screenshots/agent-dev-mobile.png` |
| Retrieval baseline | `node scripts/agent-retrieval-eval.mjs` | legacy in-memory measurement: recall@8 0.5172 → 0.9655, 0 no-answer false positives; **not SQL evaluation evidence** |

## Implemented and covered in this follow-up

- **C1/C2 (partial, offline):** strict async complete schema, complete replay, job/run/token/lease checks in the success CTE, and stable request identity for queued research. S01–S05 cover the repaired paths. The synchronous and automatic paths still use their pre-existing CTE helpers rather than one common transaction façade, so this is not a complete C1 implementation.
- **C4/C6 (partial, offline):** fixed workflow respects policy output limit and zero model allowance; stream calls append an audit event; zero tool budget does not expose Skill middleware; ancestor symlink reads are rejected with bounded reads; MCP refuses credential-bearing redirects.
- **C7 (partial, offline):** failed known-not-sent work releases the reservation and daily total (S08). It does not yet calculate actual provider cost, persist known/unknown usage pricing, or perform execution-day transfer.
- **C8 (partial, offline):** checkpoint saves reject expired runs and same-sequence changed payload; HTTP 409 propagates; worker surfaces completion non-2xx. Real Eino interrupt/Resume, lease renewal, and process kill/restart recovery are not implemented or proven.
- **C9 (offline):** research and briefing selection now produce no more than 12 sources and 24,000 Unicode code points (M01/M02).

## C1–C12 status

| Task | Status | Exact boundary |
| --- | --- | --- |
| C1 transaction completion | Partial | Async complete uses one fenced SQL CTE; no shared `Sql.transaction` entry across sync, async, and auto paths; no real PG rollback/competition proof. |
| C2 request identity | Partial | Async question hash is separated from material hash and retries are classified; persisted provider/policy/sources/scope snapshot is incomplete. |
| C3 worker/capability/UI | Partial | Worker ACK failures propagate; UI still does not present a real async choice or comprehensive not-found/history-citation flow. |
| C4 common budget | Partial | Fixed flow/Stream/Skill zero-limit probes pass; repair usage aggregation and full tool budget accounting need dedicated formal coverage. |
| C5 MCP receipts | Partial | Redirect credential leak blocked; persistent authenticated MCP receipt write, Close lifecycle and bounded decoded blocks remain absent. |
| C6 Skills | Partial | Ancestor links, walk errors and bounded reads repaired; Windows junction / different-volume proof not run. |
| C7 costs | Partial | Release updates daily reservation total; actual-cost settlement, prices, cross-day audit and PG last-unit race remain absent. |
| C8 checkpoint recovery | Partial | stale/version/same-sequence guards pass; no true Resume/renewal/worker-process recovery. |
| C9 materials | Passed for stated caps | M01/M02 pass; broader freshness/OCR/metadata cases remain existing but not re-certified in a DB race. |
| C10 SQL retrieval evaluation | Not run | Script still evaluates an in-memory corpus, not production candidate SQL/rank/truncation. |
| C11 full integration gate | Not run | Existing `agent-e2e.mjs` is helper/fetch validation, not browser + isolated DB + fake worker/MCP harness. |
| C12 real integration | Not run by authorization | no model/MCP/production/deploy call; all paid and production switches remain off. |

## Explicitly not run / blocked

- PostgreSQL PG-F01/PG-F02 and remaining real multi-connection completion, budget, checkpoint/lease races: no isolated review PostgreSQL port/container was configured.
- `go test -race`: attempted with `CGO_ENABLED=1`, blocked by host compiler `cc1.exe: sorry, unimplemented: 64-bit mode not compiled in`.
- Built-output browser smoke: `npm run preview:restart` is Linux `/proc`-only and exits with `[preview] no /proc`; no substitute production server was used.
- Worker process kill/restart recovery, true Eino Resume, MCP persistent receipts, actual SQL retrieval evaluation, actual browser Agent flow, real model/MCP, compose/deploy/rollback: not completed.

## Original work status

Original 20 tasks and the remediation 16 tasks remain **partial overall**. The passing regressions above prove only their listed offline boundaries; they do not justify a claim that the P1/P3/production Agent integration is complete.
