# Collection capability acceptance

Recorded 2026-10-13 in isolated `codex/collection-capability`. A01–A04 are implemented and reviewed. A05 implementation and deterministic offline checks passed; **24-hour live acceptance remains pending** because the five public feeds resolve to addresses refused by the existing outbound policy. No production deployment occurred.

```json
{
  "scope": "A01-A05 collection-capability",
  "baseline": "bec6212ac0cdc67272e488073e35d97087e7447a",
  "A05_base": "82b4a1032b165d1363c7b422cd99bc069d6bd4be",
  "implemented": ["A01", "A02", "A03", "A04", "A05"],
  "offline_passed": true,
  "live_passed": false,
  "live_status": "pending_network_environment",
  "release_status": "not_deployed",
  "full_suite_status": "blocked_by_existing_deployment_assertions"
}
```

## Baseline and changes

- Node `v24.16.0`, Docker engine `28.0.1`; locked dependencies installed without package or lockfile changes. Original workspace changes were preserved. The generated route file and QA artifacts are excluded from the A05 commit.
- A01 recorded the baseline and existing checks (`b3996d63`). A02 removed both 24-entry truncations; shared RSS and WeChat primary reject more than 1000 raw entries, and malformed/unsupported shared RSS input fails (`3c5f2e4c`). Long-body and gateway protections remain covered.
- A03 fairly merges the five keyword response groups within 40 items; five saturated groups receive eight slots each and retain original attempt counts (`789c768e`). This does not assert exhaustive platform search.
- A04 persists finite-window coverage in `jobs.coverage` through migration `0030_collection_coverage.sql`, renders the corresponding jobs badges, keeps capped Bilibili cursors unchanged, and prevents gateway failure bypass. Review fix chooses newest dated opaque window anchors independently of upstream ordering (`82b4a103`). Undated opaque RSS ordering remains explicitly limited.
- A05 adds a real 60-entry `runSourceJob` ingestion/replay test, expands the existing PostgreSQL burst runner, and provides an optional finite five-feed observer. No dependencies or general collection framework were added.

## Deterministic verification

All A05 test children use `scripts/readiness-offline.mjs`'s runtime allowlist with explicit automatic analysis/extraction/agent flags disabled, no inherited database URL, blank XAI key, nonexistent absolute model-config path, and test runtime. Feed/provider inputs are transport fixtures. Load runs use fresh disposable loopback Docker PostgreSQL databases and real migrations. Observer runs use fresh in-memory PGlite. No production DB, model, article fetch, media worker, or paid call is used by these A05 checks.

| Child command | Exit | Actual result |
| --- | --- | --- |
| `node --experimental-strip-types --test src/lib/server/rss.test.ts src/lib/server/cursor.test.ts src/lib/server/scheduler-atomic.test.ts src/lib/server/scheduler.test.ts` | 0 | 28 passed; final run 18.32 s |
| `node --test src/lib/server/collectors/keyword-contract.test.mjs src/lib/server/collectors/pagination.test.mjs` | 0 | 26 passed; 72.69 s |
| `node --test workers/wechat-gateway/*.test.mjs` (explicit file list on Windows) | 0 | 117 passed; 2.45 s |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | No diagnostics |
| Scoped ESLint on A05 test/load/observer files | 0 | No errors or warnings |
| `node validation/collection/public-feed-observation.mjs --self-check` | 0 | Independent 60-ID oracle, Atom identity/link mapping, missing identities, normalization collisions, bounded capture and upstream cancellation |

The 60-entry test loads the production scheduler and `getSql()` through existing Vite SSR/PGlite migration entry points. Expected IDs come directly from the fixture. Two actual jobs return `items_new=60` then `0`; SQL contains exactly 60 distinct external IDs, no missing ID, and initial-window then overlap coverage. It never manually inserts fixture items.

Raw command logs: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/a05-{a01,keyword,gateway,typecheck,lint,reference}.log`. The full implementation report and isolation wrapper are retained beside them.

## Comparable burst measurements

Each run has 100 sources, two distinct upstream rounds and an identical second-round replay. `--entries` defaults to 60 and is bounded at 1–1000; ID serials use the entry count so large fixtures cannot overlap rounds. Reference IDs are independently generated, and `source-ids.json` lists every reference/stored ID and omission per source.

| Measurement | `--entries 10` baseline | `--entries 60` |
| --- | ---: | ---: |
| Entries returned across three feed rounds | 3000 | 18000 |
| Distinct reference IDs / persisted IDs | 2000 / 2000 | 12000 / 12000 |
| New rows: round 1 / round 2 / replay | 1000 / 1000 / 0 | 6000 / 6000 / 0 |
| Missing IDs / duplicate pairs | 0 / 0 | 0 / 0 |
| RSS requests / all fixture requests | 300 / 330 | 300 / 330 |
| Errors / deferred per pass | 0 / 0 | 0 / 0 |
| Round 1 / round 2 / replay wall ms | 1198 / 1134 / 1287 | 5200 / 4966 / 6068 |
| Due-to-start P95 ms, same order | 1085 / 1037 / 1180 | 4814 / 4390 / 5705 |
| Node sampled peak RSS bytes | 203640832 | 221794304 |
| Node sampled peak heap-used bytes | 75086776 | 82300120 |
| PostgreSQL database bytes | 10902551 | 16014359 |

Requests stay fixed as entry count increases. Sampled Node RSS is about 194.2 MiB versus 211.5 MiB; this bounded sample shows no request amplification or runaway allocation. **100 ms `process.memoryUsage()` samples cover only this Node process**, omit allocations between samples, and do not measure PostgreSQL or whole-machine peak. Larger stored datasets naturally occupy more DB space. These are burst measurements, not long-term memory or endurance evidence. Every source job records `window_only`; no historical coverage is inferred.

Evidence directories, each with `result.json`, `source-ids.json`, `memory-samples.json`:

- `artifacts/production-readiness/load/run-100-umYQMY` — 10-entry baseline.
- `artifacts/production-readiness/load/run-100-Xw7NiL` — 60-entry run.

Both commands exited 0; both owned containers were removed. Their full logs are `scratch/a05-load-10.log` and `scratch/a05-load-60.log` under the roadmap execution directory.

## Public snapshot and pending live observation

`node validation/collection/public-feed-observation.mjs --snapshot` was executed once with sandbox escalation on 2026-10-13. Exactly five existing public RSS seed sources were attempted: qbitai, ifanr, sspai, solidot, BBC technology. All five jobs failed with **`blocked_address`** before an HTTP response. A separate escalated DNS-only check confirmed all five hostnames resolved within **198.18.0.0/15**, the non-public benchmarking range. The unchanged policy correctly refused them. No retries, egress override, proxy/secret configuration access, or weakened guard was used.

Snapshot exit: 1. Jobs: 5 attempted / 0 successful. Returned upstream IDs and relative omissions are **unknown (`null`)**, comparison is **incomparable**; empty arrays in older aggregate evidence do not establish zero omissions. Five per-source JSONL records and summary are retained at `artifacts/collection-capability/public-observation/snapshot-bKCaf0`. Command and DNS evidence: `scratch/a05-public-snapshot.log`, `scratch/a05-public-dns.log`. No upstream XML exists because no response was received. The 24-hour observer was not started in this blocked environment.

The standalone observer requires explicit `--snapshot` or `--observe-24h`. The latter schedules 13 rounds at 2-hour offsets 0–24, sequentially, maximum 65 source jobs plus policy-validated redirects. Each actual response is captured bounded while the same bytes flow through production `publicFetch` and `runSourceJob`; no second reference request is made. Independent XML identity enumeration checks guid/id/link only; missing identities and 320-character normalization collisions are explicitly incomparable. JSONL is saved after every job, XML and SHA256 after every consumed response, and the final summary is atomically replaced. The report always marks response-window-external history unobservable. Interruptions, more than five-minute schedule lateness, incomplete time, failures or incomparable identities cannot pass 24-hour acceptance.

Once this network environment permits policy-valid public resolution, the controller can run:

```powershell
node validation/collection/public-feed-observation.mjs --observe-24h
```

Output goes to a new `artifacts/collection-capability/public-observation/24h-*` directory; no production registration or broad cron worker is needed. No `live_passed` status is granted by preparing this command.

## Controller build, broader gates and UI evidence

After the A04 final cursor fix, the controller's full build passed using a temporary `W:` alias to the same source: an existing TanStack code-generation escaping issue fails under the original apostrophe-containing Windows path. Typecheck passed. Full lint: 0 errors, 38 existing warnings.

Dev and current built output passed desktop/mobile QA: five coverage states × two modes × two viewports = 20 article checks; console/page errors 0, horizontal overflow 0, baseline divergence false. Desktop/mobile screenshots were visually inspected. Evidence: `screenshots/collection-jobs-2026-10-13T05-52-05-430Z/result.json` and paired screenshots; method/timing detail in `scratch/ui-final-report.md`. The generic one-second smoke timer needed a bounded fixture-readiness wait in a scratch adapter; original smoke checks and error collection were preserved. This uses isolated fixtures and establishes UI rendering, not upstream or production reliability.

**Full `npm test` is not reported green.** The controller hit two existing deployment assertions: MINIO_ENDPOINT environment inventory and opencode `pids_limit` expected 64 / actual 512. The relevant scripts/Compose are unchanged against `bec6212a`. The existing service-env test reads `F:/loom-backups/env/*.env` internally and prints key names, so the entire controller suite is not described as secret-file-free. Remaining stages ran separately; keyword/pagination and research stages passed. Three legacy-model checks initially conflicted with the deliberately nonexistent model-config override; direct-Node focused reruns with that variable blank passed without the autodiscovery wrapper. These baseline gate limitations remain explicit.

Scope ends at A05 code and offline verification. Live 24-hour acceptance, deployed uptime and release remain pending; B/C work was not implemented.

## Final review repair verification

The consolidated repair wave starts from `d6bba897f8ec8ef8d4efe9a23346899d42b37cab` and addresses final review I1/M1. `completeSourceClaim` now normalizes the selected anchor date to ISO or null at its shared SQL boundary; existing SQL coalescing retains the last valid timestamp when a new anchor has an invalid, empty or missing date. Keyword diagnostics classify `invalid_feed_xml`, `invalid_feed_root` and `feed_entry_limit` as `invalid_response`.

New regressions were run before the fixes: the real first-window invalid-date scheduler replay failed with a PostgreSQL timestamp error and zero counts; three routed malformed/unsupported/over-limit feed responses returned `network_error`; the shared timestamp-preservation check failed on `invalid`. All RED commands exited 1 for those concrete assertions.

After the fixes, the same explicit offline runtime allowlist and disabled automatic flags produced these actual results:

| Child command | Exit | Actual result |
| --- | --- | --- |
| `node --test src/lib/server/collectors/pagination.test.mjs src/lib/server/collectors/keyword-contract.test.mjs` | 0 | 27 passed; 85.93 s |
| `node --experimental-strip-types --test src/lib/server/rss.test.ts src/lib/server/cursor.test.ts src/lib/server/scheduler-atomic.test.ts src/lib/server/scheduler.test.ts` | 0 | 29 passed; 32.87 s |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | No diagnostics |
| Scoped ESLint on the five runtime/test repair files | 0 | No errors or warnings |
| `git diff --check` on the owned repair files | 0 | No whitespace errors |

The real scheduler check now records one normalized item, successful counts `1/1` then `1/0`, discovery anchor `unknown`, and initial-window then overlap coverage. The shared PGlite check advances new anchor IDs while preserving an existing valid publication timestamp for invalid/empty/null dates. Existing numeric monotonicity, Bilibili page caps, opaque ordering, Telethon compatibility and genuine socket failure diagnostics remain covered by the passing suites.

Repair logs and exact isolation wrapper: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/final-fix-{red,red-atomic,green,atomic,typecheck,lint}.log` and `final-fix-checks.mjs`; full repair report: `final-fix-report.md` beside the task reports. These checks made no live feed request, production database access or paid call. Public snapshot/load, broad baseline deployment assertions and controller build/UI were not rerun by the repair worker; the controller owns refreshed build/UI and scoped final review. Live 24-hour acceptance and release status remain pending.

## Post-review gates and current UI evidence

Runtime commit `b8cce07b185f92df83d050151f6e9470d593aae6` passed the independent final scoped review: I1/M1 closed, no new breakage reported (`review-final-fix.md`). After that repair, actual isolated `npm run build` and `npm run typecheck` exited 0; full `npm run lint` exited 0 with **0 errors, 36 warnings**. The gate wrapper/logs and detailed verification report are under `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/ui-post-review-{gates.mjs,gates.json,build.log,typecheck.log,lint.log,report.md}`.

Latest dev and freshly built output passed the same desktop/mobile jobs checks: **20 article checks, 0 console/page errors, 0 horizontal-overflow viewports, built/dev smoke divergence=false**. Four viewport screenshots were visually inspected. Final retained evidence directory: `C:/Users/yi'da'dui/.codex/worktrees/collection-capability/WeaveSense/screenshots/collection-jobs-2026-10-13T06-29-25-838Z/` (`result.json`, `dev-smoke.png`, `dev-smoke-mobile.png`, `built-smoke.png`, `built-smoke-mobile.png`, and paired verdicts/full-page labels). This keeps the bounded fixture-readiness smoke adapter and all original error/auth/brand checks; existing utility BRAND NOTE is retained and actual BRAND WARNING is absent. Same-call W: alias and exact owned process trees were cleaned and absence verified; user services were untouched.

This refresh establishes current build/UI rendering with isolated fixtures. **Full npm-test baseline failures are preserved above; no full-suite green claim, live 24-hour acceptance, deployed-uptime acceptance or release status is added.** No load/gateway repetition or live feed request was needed for this repair verification.
