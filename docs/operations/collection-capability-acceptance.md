# Collection capability acceptance

Recorded 2026-10-13 in isolated `codex/collection-capability`. A01–A04 are implemented and reviewed. A05 implementation and deterministic offline checks passed; **24-hour live acceptance remains pending** because the five public feeds resolve to addresses refused by the existing outbound policy. No production deployment occurred. B01–B03 implementation/offline evidence and B04 sample bookkeeping are now recorded in the final B scope section; public-reader quality remains pending. The A-only JSON and full-suite failure notes below are historical results, not a current full-suite verdict.

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

**Historical A-only full `npm test` failed.** That earlier controller hit two existing deployment assertions: MINIO_ENDPOINT environment inventory and opencode `pids_limit` expected 64 / actual 512. The relevant scripts/Compose are unchanged against `bec6212a`. At that earlier revision the service-env test read `F:/loom-backups/env/*.env` internally and prints key names, so the entire controller suite is not described as secret-file-free. Remaining stages ran separately; keyword/pagination and research stages passed. Three legacy-model checks initially conflicted with the deliberately nonexistent model-config override; direct-Node focused reruns with that variable blank passed without the autodiscovery wrapper. These historical failures remain visible. B04 subsequently replaced real-secret inventory reads with public-template assertions and corrected the MINIO/pids-limit inventory; C02 extended its topology/template guard. Current checks do not read F: env files. The final R01 full-suite result is reported separately rather than inferred from either old failures or focused passes.

Historical A05 scope ended at A05 code and offline verification; B/C had not been implemented at that point. Current B implementation and remaining public-quality gates are recorded below. Live 24-hour acceptance, deployed uptime and release remain pending.

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

## B01–B04 article enrichment scope (2026-10-13)

B01–B03 implementation and independent offline review are complete. B04 adds the fixed public sample manifest, an inert/bounded verification entry and a portable environment guard. **The live 20-article quality gate has not passed.** Reader configuration stays disabled with an empty verified hostname list; this document grants no production release.

| Gate | implemented | offline_passed | live_passed | deployed |
| --- | --- | --- | --- | --- |
| B01 bounded public candidate reader | yes | yes | no: successful hosted Jina body not verified | no |
| B02 candidate/cache/adopt/restore/version fences | yes | yes | no public-provider acceptance | no |
| B03 detail operations and mobile text rendering | yes | yes | no public-provider acceptance | no |
| B04 public sample bookkeeping and portable guard | yes | yes | no: quality/completeness remains unknown | no |

Runtime evidence is bound to B03 `c818665a1ebccb7c910e99e65fea755b023f7a51`, and its additional layout check to `d611c409`. Independent QA used actual `npm run build` with a fresh native PostgreSQL ledger, applying 29 real migration files ending `0030_collection_coverage.sql`. Separate dev/built 1280×844 and 390×844 detail flows passed real serverFns/transactions/version triggers, candidate-only read, cache, reader-disabled adoption/restore, persistence, conflicts, preserved OCR/history and unchanged automatic model/extract counts. Actual 20-second drip cancellation measured 19,997/20,010 ms with destroyed request, closed response and no active transport. A native two-process shared-DB schedule proved its specific lease/cache/stale-adopt interleavings. Long-token dev/built measurements passed using the existing inherited wrapping rule; no runtime wrapping fix or manufactured failure is claimed.

Detailed source/evidence: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/task-B02-report.md`, `task-B03-report.md`, `scratch/ui-B03-report.md` and `scratch/ui-B03-longtoken-prefixed-report.md`. Screenshots/verdicts are the `screenshots/readiness-b03-76349378-8c59-4f43-be6a-8e20c5ecea53-{dev,built}-result.json` and the layout verdicts named in those reports. These controlled upstream fixtures are not successful public-page readings.

### Fixed sample/reference contract

[article-reader-samples.json](../../validation/collection/article-reader-samples.json) fixes 20 distinct HTTPS articles across three existing business publishers: 9 ifanr, 10 sspai, 1 qbitai. The exact observed `go-post.sspai.com` addresses remain unchanged. Reference page shapes include short/long text and illustrations; **Feed-missing/summary/body-already-existing distribution remains unknown**, because no matching original Feed/item payload was captured. Each record keeps original Feed body `null`, Feed status `unknown`, and the original article hostname's independent DNS status unprobed.

Public publisher pages were observed through the official-site web route on 2026-10-13. Only short **paraphrased reference facts** are retained: beginning, ending and three middle points. They are not literal markers and must never be passed to `includes()` as a completeness oracle. Literal beginning/ending fields are `null`, `manual_reference_required=true`, and no candidate comparison has occurred. The ifanr 1681605 display title omits the source page's invisible control characters; exact raw title equality is not asserted. Future manual comparison must verify the actual title/domain/beginning/ending/three middle facts; visible length alone, a returned response, adoption or absence of challenge words is insufficient.

| Sample | Fixed original article |
| --- | --- |
| B04-01 | [www.ifanr.com/1683545](https://www.ifanr.com/1683545) |
| B04-02 | [www.ifanr.com/1682644](https://www.ifanr.com/1682644) |
| B04-03 | [www.ifanr.com/1681605](https://www.ifanr.com/1681605) |
| B04-04 | [www.ifanr.com/1678195](https://www.ifanr.com/1678195) |
| B04-05 | [www.ifanr.com/1678196](https://www.ifanr.com/1678196) |
| B04-06 | [www.ifanr.com/1676929](https://www.ifanr.com/1676929) |
| B04-07 | [www.ifanr.com/1675465](https://www.ifanr.com/1675465) |
| B04-08 | [www.ifanr.com/1674363](https://www.ifanr.com/1674363) |
| B04-09 | [www.ifanr.com/1673651](https://www.ifanr.com/1673651) |
| B04-10 | [sspai.com/post/110939](https://sspai.com/post/110939) |
| B04-11 | [sspai.com/post/107458](https://sspai.com/post/107458) |
| B04-12 | [sspai.com/post/108407](https://sspai.com/post/108407) |
| B04-13 | [sspai.com/post/108066](https://sspai.com/post/108066) |
| B04-14 | [sspai.com/post/105732](https://sspai.com/post/105732) |
| B04-15 | [sspai.com/post/112552](https://sspai.com/post/112552) |
| B04-16 | [sspai.com/post/109346](https://sspai.com/post/109346) |
| B04-17 | [sspai.com/post/112100](https://sspai.com/post/112100) |
| B04-18 | [go-post.sspai.com/post/109365](https://go-post.sspai.com/post/109365) |
| B04-19 | [go-post.sspai.com/post/111706](https://go-post.sspai.com/post/111706) |
| B04-20 | [www.qbitai.com/2026/07/443842.html](https://www.qbitai.com/2026/07/443842.html) |

All 20 currently have explicit `not_attempted_due_to_shared_provider_block`, candidate usability/completeness `unknown`, and adoption not requested. This is a decision based on prior shared-reader evidence, **not a claim that each original article URL or hostname was tested and blocked**:

- A05's five guarded Feed failures: `artifacts/collection-capability/public-observation/snapshot-bKCaf0/rounds.jsonl` and `summary.json`.
- B01's actual anonymous Jina 401/IP-reputation response for example.com: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/task-B01-report.md`, “Official contract and live sample”; actual rejection shape also remains in `src/lib/server/article-reader.test.ts`.
- Independent disposable-container DNS-only diagnostic: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/network-dns-diagnostic.md`, including r.jina.ai benchmarking addresses.

No repeated live request, DNS override, Key/Cookie, authentication retry or heavy browser fallback was used for B04. Current actual sample metrics: request-return rate `null`, candidate-usable rate `null`, verified-complete rate `null`, error-page false-pass rate `null`; verified hostname allowlist `[]`. No unknown result enters the completeness numerator. Target ≥90% applies only to reachable in-scope samples after actual comparison; zero error-page false acceptance must also be demonstrated then. Until that live gate passes, no publisher hostname is promoted to supported status. Third-party charges remain unknown, not reported as zero from lack of a key.

### Reproducible B04 checks and later opt-in reading

Run from the repository root using the existing isolation wrapper:

```powershell
node scripts/readiness-offline.mjs -- node --test scripts/service-env-least-privilege.test.mjs
node scripts/readiness-offline.mjs -- node validation/collection/article-reader-validation.mjs --self-check
node scripts/readiness-offline.mjs -- node validation/collection/article-reader-validation.mjs
```

The first checks all public template variable inventories and runtime isolation. The second rejects duplicate URLs, fabricated Feed status and paraphrases disguised as literal references; exercises stable DNS/auth barriers with exactly one attempted read and 19 unattempted rows, bounded batch admission, unknown completion for returned candidates and unknown partial progress after child interruption. Its fixtures are bookkeeping checks, not public-reader results. The third emits the honest 20-row prior-barrier report with no network. The modified test remains in existing `npm test`; the runner has this independent documented entry. Actual B04 output/logs: `scratch/b04-{boundary-red,boundary-green,service-env,self-check}.log` and `scratch/b04-public-bookkeeping.json` under the roadmap execution directory.

Only after the network environment has changed to permit policy-valid public resolution and the provider's anonymous route is available may an operator explicitly request:

```powershell
node scripts/readiness-offline.mjs -- node --experimental-strip-types validation/collection/article-reader-validation.mjs --run --network-changed
```

`--run` alone refuses without making a request. The normal real reader retains exact HTTPS/query/hash/WeChat/DNS/body/timeout protections; the validation-only host set does not change application configuration. The child drops ambient secrets/config and egress declarations, has a 60-second process ceiling and admits requests for at most 40 seconds (each actual reader has its 20-second total budget). The first stable blocked_address, blocked_host, dns_no_answer or HTTP 401/403 stops remaining requests conservatively. Propagated reader errors do not identify whether original-host or provider validation failed: observed-batch errors record failure_stage=unknown_original_or_provider, remaining rows record not_attempted_due_to_ambiguous_reader_barrier with stopped_after_error (not a per-row exception), and original-host DNS stays unknown. This does not establish provider-wide failure or failure of any unattempted hostname. The default prior-barrier report separately cites the independently observed Jina/DNS evidence above. No item, cursor, production configuration or adoption is changed. Candidate bytes/digest/hostname are recorded without archiving publisher full text; usability and completeness remain unknown until manual comparison. An interrupted child reports unknown partial progress, not a fabricated completed run.

### Disable/rollback and packaging boundary

`ARTICLE_READER_ENABLED=false` forbids new reads. Existing completed candidates are retained and may be adopted; already adopted body and guarded restore continue working. Ordinary Feed collection remains independent, and summaries cannot replace adopted full text. Failure/conflict preserves original body; restore requires the adopted material version and refuses to erase later OCR/ASR or edits. Rollback never resets source cursors, deletes items or removes snapshots. The B02 focused checks and B03 native dev/built flows above are the current implementation evidence for those properties; no broad suite was repeated just to restate them.

The server reader uses no Key/Cookie; public templates contain placeholders plus disabled/blank reader settings. B04 adds no secrets/config reads or package generation. The existing source pack exclusion policy remains unchanged, and no fresh source archive or production image is claimed. R01 owns the refreshed full-suite/build/release ledger; production publication and 72-hour observation remain pending.

## C01–C04 scope and pending live gates

C02 application QA is bound to `42b508d03b9ac6b4769a8a845afd733cca90af41`; the relay-only fix is `7e588e62` and leaves those application files unchanged. Actual reviewed local worker image is `sha256:3346991de8f9e5292cfc8eccc2b2824795377bc47c3ebc445b8a2f06050e2803`: Linux10 tests with zero failures/errors/skips and actual worker network-isolation controls passed. The real >5s relay regression supplies response-header/shared46s deadline proof; the independent application fixture does not cross that relay. Older worker-image/protocol9 evidence and the app report's then-pending relay defect are historical, superseded only for that fixed issue. No image push or production activation is claimed.

Unchanged app QA used actual `npm run build` on fresh native PostgreSQL, 29 migration names through `0030_collection_coverage.sql`, separate dev/built databases and real private MinIO. Both 1280/390 detail flows exercised strict serverFns, material triggers/CAS, finite en/zh-Hans/zh-Hant manual/automatic subtitles, repeat/conflict/no-subtitles/malformed/upload-failure behavior, preserved OCR/ASR/history, unchanged automatic-job counts and safe public projection. Four known-present JSON3 objects were authenticated-read byte-for-byte; anonymous GET actually returned403/AccessDenied. The original dev client50s drip measured50,015ms with closed transport/active0. Dev desktop/mobile screenshots were inspected together, errors0/overflowfalse; all exact owned resources were removed. Evidence: `scratch/ui-C02-report.md`, `scratch/c02-fix1-isolation.json` and `screenshots/c02-6a867a2c-307d-436c-a75e-04d2cc3c3459/{dev,built}-result.json` under the roadmap execution/worktree roots. These are controlled upstream fixtures, not real YouTube readings.

`SUBTITLE_ENABLED=false` and the optional `subtitles` profile remain off. The fixed extractor's public-host completeness is provisional; live support is not established merely by allowing `www.youtube.com:443`. No arbitrary URL/flags/Cookie reaches the worker, no paid ASR/model fallback, no public transcript object key. Exact raw JSON3 stays in private `loom-subtitles`; text/metadata stay subject to material-version checks. [Subtitle pilot](subtitle-pilot.md) retains actual C01 tool/synthetic evidence and the real-service prerequisites.

C03 `187a245a` uses existing RSS/collector/scheduler code and the three disabled Agent-Reach/Obscura/Jina-reader release manifests. Its final44 synthetic calls, zero real HTTP, refusal/inert checks passed and task review is approved. [Channel pilot](channel-pilot.md) records raw/normalized IDs, incomparable windows, finite stop and actual72h/new-arrival conditions. Live duration is0, real release IDs/fees/omissions unknown; GitHub code/issues/commits/repository search is outside this pilot. No source was inserted/enabled in production. C04's reviewed assessment `8bd35fd6` remains conditional as described below.

## C04 conditional browser assessment (2026-10-13)

The conditional assessment is implemented; status is **`waiting_for_verified_js_gap`**. The browser experiment is untriggered and live acceptance remains pending. B04 made no actual reads of its 20 articles, captured no original Feed bodies and has no candidate/reference comparison or verified completeness. Its retained paraphrased references do not establish literal extraction markers. The prior DNS/provider failures prove neither JS dependence nor ordinary HTTP/Feed sufficiency; `not_needed` is unsupported. No browser benchmark, page manifest, browser-collector service or Obscura dependency is added before the condition is proved. Evidence is the B04 scope/barrier record above and `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/task-C04-notes.md`.

The trigger is policy-valid reachable HTTP/Feed evidence, actual reference comparison and an in-scope target demonstrably missing without JS and available through JS rendering. Fix access/account scope, selectors and literal markers first; only demonstrated HTTP/Feed satisfaction permits `not_needed`. A triggered comparison uses the same 20 eligible public pages and extraction targets: existing Playwright/Chromium first, then fixed-version Obscura through the same CDP extraction script and waits, concurrency 1, a fresh finally-closed context and a true 30-second total deadline per page. Navigation, subresources, WebSockets, service workers and downloads require controlled egress. Record engine/version/URL/status/marker result/duration/peak RSS/error. Adoption requires key-page correctness no worse than Chromium, no new resource leaks and at least 30% improvement in duration or peak memory; otherwise retain Chromium/existing flow. The pilot grants no all-platform compatibility or deployment claim.

## R01 portable checks and final unified verification

R01 reuses the seven B03 and six C02 QA helpers under tracked `validation/collection/`. `scripts/readiness-ui.mjs` imports the stable B03 fixtures/control; no ignored plan-scratch module is needed to reproduce a clean checkout. Fixture/backend/business assertions remain the existing ones. Helper source/preload paths are separate from ignored `artifacts/collection-capability/ui/` controls/logs/reports; screenshots stay under `screenshots/`. Owned apps stop before PostgreSQL/MinIO disposal, and cleanup failures remain failures.

The new portability regression first failed on the absent stable helper, then passed both clean-checkout dependency and inert-preload/safe-default checks. Scoped helper/UI lint passed with no warnings after two transferred-helper findings were repaired. No framework, main dependency, migration or production behavior was added.

`npm test` now invokes `test:collection`, which runs the existing article-reader/enrichment/subtitles/article-contract checks, the portable dependency/env regression, and article-validation/C03-observer self-checks. Default tests require no Docker, Python, yt-dlp or real network. Use explicit allowlisted test values; direct Node tests use blank model configuration to preserve valid fallback assertions:

```powershell
$r01PreviousOverrides = $env:LOOM_OFFLINE_OVERRIDES
$r01NpmCli = Join-Path (Split-Path (Get-Command node).Source) 'node_modules/npm/bin/npm-cli.js'
try {
  $env:LOOM_OFFLINE_OVERRIDES = '{"LOOM_RUNTIME_MODE":"test","AI_ENGINE":"legacy","DATABASE_URL":"","LOOM_MODEL_CONFIG":"","XAI_API_KEY":"","AUTO_ANALYZE":"false","EXTRACT_AUTO":"false","AGENT_WORKER_ENABLED":"false","AGENT_ASYNC_RESEARCH_ENABLED":"false","AGENT_OPENCODE_WORKER_ENABLED":"false","AGENT_ASSISTANT_ENABLED":"false","AGENT_ASSISTANT_ACTIONS_ENABLED":"false","ARTICLE_READER_ENABLED":"false","ARTICLE_READER_ALLOWED_HOSTS":"","SUBTITLE_ENABLED":"false","SUBTITLE_URL":"","SUBTITLE_SERVICE_TOKEN":""}'
  node scripts/readiness-offline.mjs -- node $r01NpmCli run test:collection
} finally {
  if ($null -eq $r01PreviousOverrides) { Remove-Item Env:LOOM_OFFLINE_OVERRIDES -ErrorAction SilentlyContinue }
  else { $env:LOOM_OFFLINE_OVERRIDES = $r01PreviousOverrides }
}
```

For the full gate use the same wrapper/environment with npm `test`, `gateway:test`, `typecheck`, `lint` and retain each actual exit/log; a failed internal && stage leaves later stages unrun. Full application builds must instead use a nonexistent absolute model-config path and a generated disposable native-PG DSN. The existing portable build helper runs actual npm build including db:migrate on an initially empty ledger and compares exact migration names; a no-DATABASE_URL migration skip or bare Vite build is insufficient. Vite refuses root dotenv filenames before startup; no secrets/model/F: env contents are read.

Optional full QA entries, with cached Docker PostgreSQL/MinIO images and installed Playwright Chromium, start only disposable loopback instances and never user8080/8182 services:

```text
npm run qa:collection:articles -- --native-fence
npm run qa:collection:subtitles
```

### Windows checkout path containing an apostrophe

The npm QA entries above run directly from a checkout without an apostrophe in its path. This machine's current checkout contains one; the installed TanStack build dependency cannot quote that path. Use an unused drive alias within the **same PowerShell call**, change directory before launching any Node/npm/helper, and remove only the alias created here in finally. Do not import a helper from C: and then change directory: its ROOT would already be bound to the original path. If W: is occupied, choose another unused drive letter; never replace an existing mapping.

```powershell
$r01RealRoot = "C:\Users\yi'da'dui\.codex\worktrees\collection-capability\WeaveSense"
$r01Drive = 'W' # Set another unused letter if W: is occupied.
$r01Alias = $r01Drive + ':'
$r01RealRoot = (Resolve-Path -LiteralPath $r01RealRoot).Path
if (Get-PSDrive -Name $r01Drive -ErrorAction SilentlyContinue) { throw 'QA drive is already occupied' }
subst $r01Alias $r01RealRoot
if ($LASTEXITCODE -ne 0) { throw 'QA drive alias creation failed' }
try {
  Set-Location -LiteralPath ($r01Alias + '\')
  # Choose ONE entry; both retain their full default checks.
  $r01QaEntry = 'qa:collection:articles' # Or qa:collection:subtitles.
  npm run $r01QaEntry -- --skip-timeouts
  if ($LASTEXITCODE -ne 0) { throw 'QA failed; retain its report' }
} finally {
  Set-Location -LiteralPath $r01RealRoot
  subst $r01Alias /d
  if ($LASTEXITCODE -ne 0) { throw 'Owned QA alias removal failed' }
}
```

This example deliberately selects the relocation check with timeouts_skipped; omit --skip-timeouts only when the full real deadline check is required. No user service is restarted, cached Docker images are required, and helper subprocess environments remain allowlisted. The final QA used the same-call W: approach and verified W: removed after cleanup.


The default article QA retains its real20s deadline and optional native two-process schedule; subtitle QA retains the real50s client case. For relocation-only final detail flows, explicit `--skip-timeouts` retains read/cache/adopt/restore/CAS/private-storage checks while omitting unchanged20/50s delays. Verdicts record `timeouts_skipped:true` and the original runtime SHA/evidence; omitted cases do not count as a fresh deadline pass. Final QA can share one actual build/migration helper and separate fixture/object state. Earlier unchanged worker isolation/native schedules need not repeat merely to quote them.

C01 stdlib self-check (also replays ten fixtures) and optional C02 Python units use a supplied supported interpreter; they are separate documented commands, not global prerequisites for npm test:

```text
node scripts/readiness-offline.mjs -- <absolute-Python-executable> -I validation/collection/subtitle-validation.py --self-check
node scripts/readiness-offline.mjs -- <absolute-Python3.12> -I -m unittest discover -s workers/subtitle -p test_server.py
npm run test:subtitles:isolation -- <existing-local-report-directory>/isolation.json
```

Replace the Python placeholders with real executable paths: Python >=3.10 for C01, Python3.12 for C02 units. Local Windows units may skip Linux process/file-limit checks and cannot replace the optional Docker Linux proof. The Docker script uses only disposable resources and the local `weavesense-subtitle:2026.08.19` image; bind its inspected ID to the reviewed image above. No image install/pull, service activation, real subtitle/feed read or endurance observer is part of these default checks. Missing optional prerequisite is reported unmet, never a silent success.

### Final R01 actual results and source binding

The source-stable working tree was tested on launch base `8bd35fd62bd387b2af503d24e581550d31aadc76` plus the R01 working delta, then committed unchanged for runtime/package/helpers as `3530b41c91b58fcb40a8045f509389c0384557a3`. Build/check launch occurred before that commit; this is explicit provenance, not a claim that launch HEAD already was3530b41c. Final documentation follows separately, without repeating unchanged runtime checks.

| Actual gate | Exit / evidence |
| --- | --- |
| npm test | 0;545/545 Node tests across8 stages,0fail/0skip,293.315s; includes new typed24/portable2 and article20-reference bookkeeping/C03 synthetic44 self-checks |
| gateway:test | 0;117/117,0fail/0skip,4.329s |
| typecheck | 0;no diagnostics,15.492s |
| full lint first run | 1;364errors38warnings in generated ignored task/tool scratch; original failure retained |
| full lint after .superpowers/sdd-only boundary fix | 0;0errors32warnings,7.656s; stable validation/collection and actual source remain checked |
| actual npm build on initially empty native PostgreSQL | 0;build ran db:migrate and applied exactly29 real migration files through0030, full name ledger verified |
| selected portable dev/built article+subtitle detail checks | 0;1280×844 and390×844 each mode, strict real serverFns/SQL/CAS/material triggers/private storage, console/page errors[], no horizontal overflow; combined gate136.608s |

Exactly one fresh native-PG npm build served both UI families; separate dev/built DBs and private-bucket state preserved isolation. Article read/plain script/2066-character wrap/cache/adopt with reader off/reload/restore/conflict/refusals and subtitle disabled/manualen/automaticzh-Hans+zh-Hant/no-subtitles/invalidworker/upload failure/repeat+changed digest/conflict/privacy/history/OCR-ASR/no-auto checks passed. Four known-present private JSON3 objects were authenticated-read with exactbytes; actual anonymous access returned403/AccessDenied. Both article and subtitle verdicts record `timeouts_skipped:true`. Previously established20/50s/native schedules/worker isolation were not rerun or counted as new deadline proof; their actual SHA/evidence stays above.

All four first dev desktop/mobile article/subtitle screenshots were visually inspected together by QA, controller and R01 writer: readable original/candidate distinction, long-token wrap, literal scripts, language controls and preserved history/material. Fullpage mobile screenshots include fixed-navigation stitching; ordinary scrolling remains available. Built matching JSON checks show no behavioral/layout divergence, so no redundant built screenshot reread was needed.

Retained evidence paths from repository/worktree root:

- Command exits/logs: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/r01-final-9b8dc68d-9375-44b1-951e-0f74767a70d3/{gates.json,test.log,gateway-test.log,typecheck.log,lint.log}`.
- Final lint/combined gate: `.superpowers/sdd/2026-10-13-collection-capability-roadmap/scratch/r01-final-ui-gate/{gates.json,lint-after-boundary.log,combined-real-build-ui.log}`; full narrative `scratch/r01-final-execution-report.md`.
- Actual native build/ledger: `artifacts/collection-capability/ui/loom-b03-qa-5d8de3eb-fc9a-497f-adcb-52b9893b179d/{postgres-build.json,real-npm-build.log}`.
- Combined process/cleanup/MinIO report: `artifacts/collection-capability/ui/r01-final-adb6735f-1808-45f3-be75-73ff3cc13a81/runner.json`, per-mode SQLIPC/network/logs.
- Article JSON/screenshots: `screenshots/readiness-r01-final-adb6735f-1808-45f3-be75-73ff3cc13a81-{dev,built}-result.json` and matching candidate/adopted/restored/conflict/failed PNGs.
- Subtitle JSON/screenshots: `screenshots/r01-final-adb6735f-1808-45f3-be75-73ff3cc13a81/{dev,built}-result.json` and manual/automatic/invalid/conflict PNGs.

Every owned process/listener/container was removed and targeted absence verified; apps stopped before PG/MinIO removal, and temporary W: removed. Forced app exit1 after assertions is cleanup status, not a failed UI command. No user8080/8182 service, production DB/.env/Fenv/container Env or paid/public observer was touched. The current full suite is green; historical failed A results and initial R01 lint failure remain evidence rather than current blockers. Live/public quality, duration, fees, production deployment/archive/rollback image and production72h remain pending/unknown/not_started.
