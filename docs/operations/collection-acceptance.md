# Collection acceptance

T17 separates deterministic offline evidence from operational acceptance. No live source is approved by this report. The user will add RSS, Telegram and WeChat sources through the UI. The 72-hour pilot, seven-day expansion, 24-hour memory endurance and real Telegram image/audio quality remain **pending**.

## Reproduce safely

Run from the tested checkout with the existing dependencies and Docker images available:

```text
node scripts/readiness-offline.mjs -- node scripts/collection-reliability-check.mjs --offline
node scripts/readiness-offline.mjs -- node scripts/collection-load-check.mjs --sources 100
node scripts/readiness-offline.mjs -- node scripts/collection-load-check.mjs --sources 1000
node scripts/readiness-offline.mjs -- node --test scripts/readiness-offline.test.mjs
```

The first command includes real wall-clock minute ticks and two serial source profiles, taking approximately 21 minutes. `--quick` omits those timed scenarios and reports them pending. It is focused infrastructure evidence, not replacement evidence for the omitted timed scenarios. On this Windows host use `node F:/nodejs/node_modules/npm/bin/npm-cli.js` for npm commands inside the offline wrapper, and `.venv/Scripts/python.exe` for Python checks.

Each infrastructure run creates new uniquely named, ownership-labelled PostgreSQL and MinIO containers, binds only loopback, uses dummy credentials, pins repository image digests, and enforces 512 MiB / two CPU budgets per database/storage container. Cleanup verifies ownership. It never uses the production compose project, stored model settings, account sessions, provider APIs or deployment credentials. Public fake HTTP uses the existing injected transport after normal SSRF validation; a redirect to a private address remains rejected. Model requests are intercepted before network I/O and routed only to the local fake endpoint. Fake model calls are counted separately from paid calls.

## Evidence contract

Results under `validation/collection/2026-10-02/<run>/` contain `expected`, `collected`, `missing`, `duplicates`, `delay_p50`, `delay_p95`, `retry_recovery_seconds`, `max_rss_bytes`, `max_queue_age_seconds`, `paid_calls`, and `evidence_scope`. A metric not measured is an explicit `{status: "unknown", reason: "..."}` object, never zero. The validator rejects omitted fields, malformed or negative numbers, empty references, missing/duplicate identities, incomplete collections and offline paid calls. Existing test registration exercises those rejection paths.

All times are seconds unless a name ends in `_ms`. A source/reference mismatch fails even when aggregate totals agree. Load rounds compare exact IDs for every source after the first round, the second round, and unchanged replay. A job starting successfully or an HTTP 200 cannot establish completeness.

Every report records the source SHA/state, image IDs/digests, runtime, input reference set and time window. A dirty run is labelled `dirty-development-only`. A quote-free archive uses the controller's full-SHA `source-sha.txt` receipt and never discovers an unrelated parent repository SHA. Evidence-only edits are excluded from source cleanliness detection; source edits are not.

## What is exercised

- Actual scheduler RSS faults: 503, received 429 cooldown followed by body failure, invalid XML, slow body and a private redirect; manual replay cannot bypass cooldown.
- Fake Telethon over loopback HTTP: second-page failure, unchanged persisted cursor, a fresh native child process continuing from PostgreSQL, a second reference round and replay.
- Independent PostgreSQL connections with different backend PIDs and observed `pg_blocking_pids` overlap: claim race, batch lock versus reclaim, stale token fencing, media uniqueness, and final job-write rollback of content/media/progress.
- The original append-only 0024 SQL on a transactionally restored pre-migration shape: safe duplicate removal and ambiguous stored duplicate refusal, followed by rollback of the fixture schema changes.
- Three 100,000-row histories: RSS IDs, Telegram legacy aliases, and normalized WeChat URLs. The corrected WeChat fixture uses disjoint legacy/incoming external IDs for the same canonical URLs and checks the retained internal IDs. Existing 80-entry batches return exactly 80 rows; fresh batches return zero unrelated rows and insert exactly 80. Each has an actual `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, timings and Node RSS samples.
- Real MinIO upload preceding a failed PostgreSQL completion transaction; extraction remains deferred until MIME/storage metadata commit; retry retains the object key; extraction then runs once.
- Native PostgreSQL SHA256 first-four extraction query with `LIMIT 1`, dead/cooling-only newest items, no fifth-target expansion, and an exact inclusive 15-minute extraction lease boundary in a pinned transaction.
- Actual production dispatcher at injected minute/half-hour timestamps: ingest, extract and automatic analysis keep their own windows. Real cron POST handler exercises PostgreSQL enqueue-before-ACK, failed ACK, persistent SQLite reopen and idempotent replay.
- Full timed run: actual cron POST source recovery at real 60-second ticks; 14 Telegram-history fixture sources with 45-second responses and test concurrency one, comparing ordinary 55-second and Telegram 195-second media reservations within the 720-second server / 750-second loop budgets. The Telegram media response waits 120 real seconds and verifies the real MinIO object. Production source concurrency remains nine; this test does not promise fleet capacity.

## Results and limits

Development evidence is preserved, including failing fixture attempts. These are not final committed-SHA release evidence. Runtime/harness checks target `52a16ea23d7af683b57faf5d1f1fd45670ab09dc`. Final tests/typecheck and controller build/browser target `5e0bdd31c0b303e1709f62babdcfa8b7d5f99511`; the only intervening source change makes one synthetic DNS budget test deterministic. Full timed reliability and final-SHA dev/built desktop/mobile browser checks are complete; scope and limits are recorded below.

| Committed-SHA check | Result | Scope |
| --- | --- | --- |
| 100-source burst, two rounds + replay | 2,000 exact IDs, 0 missing/duplicates; 9.820 s | Accelerated due-set drain |
| 1,000-source burst, two rounds + replay | 20,000 exact IDs, 0 missing/duplicates; 31.747 s | Accelerated due-set drain |
| 1,000-source first-round wait | P50 3.165393 s / P95 6.025886 s | Actual job-start minus explicitly aged due time |
| Gateway | 127/127 | Offline fake providers |
| Python worker | 25/25 | Fake Telethon, no account session |
| Full registered npm suite | 535/535, 92.816 s | Final 5e0bdd3 tree, original command |
| TypeScript | Passed, 10.119 s | Final 5e0bdd3 native checkout |
| Full default reliability | Reported 331/331, 0 missing/duplicates, 1,330.924 s | Actual PG/MinIO, real clocks; 52a16ea; RSS identity was count-only, corrected proof below |
| Source retry | 49.255 s after eligibility | Actual second minute cron tick |
| Ordinary reserve 55 s | 13 collected / 1 deferred; 587.371 s; P95 542.296248 s | Serial 45-second sources |
| Telegram reserve 195 s | 10 collected / 4 deferred; 571.404 s; P95 406.277657 s | Same sources plus actual 120-second media storage |

The first full npm run exposed two existing millisecond timing assertions under concurrent test/build load. Both files passed unchanged in isolation (42/42). An original-command recheck reproduced only the synthetic DNS budget test: real 25 ms sleeps could miss its total 90 ms deadline under runner concurrency. The authorized one-test correction advances the existing mocked clock twice by 25 ms, requires exact remaining budgets [65, 40], and preserves the real body-abort timer and original wall-time bound. The final original suite passed all 535 tests. Both first failures and the isolated pass remain in evidence. An unsupported Node concurrency environment flag failed at setup and is not counted as a test execution.

The proposed media recovery threshold is **not met**: a retry can become eligible after 60 seconds, while the preserved ingest stage dispatches at the next half-hour window (1,800 seconds in the controlled scenario, 1,740 seconds after eligibility). Calling `ingestPending` directly is not counted as cron recovery. Both timed serial profiles also **do not meet** the proposed due-to-start P95 <=120-second threshold. Both finish inside the 720-second server / 750-second loop budgets. Exit 0 certifies the asserted behavior and evidence collection; it is not an all-gates operational acceptance.

Native Node peak RSS is process memory, not Docker-cgroup memory. PostgreSQL `memory.current`, `memory.peak`, `memory.stat` and `memory.events` refer only to its enforced container and include file cache. The final 300,000-row history run reached the 512 MiB cgroup peak (536,875,008 bytes; file 510,689,280, anon 10,416,128, shmem 146,903,040 included in file; max events 3400, OOM events zero). Native Node peak RSS was 159,965,184 bytes; this does not establish application RSS under 70% of a container budget. The application has no enforced container budget in these native runs, so the application 70% resource gate is **unknown**, and 24-hour endurance is **pending**. Production resource limits are unchanged.

For live acceptance, record each permitted source's platform, interval, accessible reference IDs, initial range and upstream window. Run 10–20 sources for 72 hours, then 100+ for seven days. Keep inaccessible/upstream-limited samples in the report, explain missing IDs, and record paid costs conservatively. Offline completeness and a short resource sample cannot close those gates.


## Final build and UI verification

Final source `5e0bdd31c0b303e1709f62babdcfa8b7d5f99511` built successfully from an exact archive. Dev and built home checks passed desktop/mobile; built did not diverge from dev. Source/jobs presentation checks each passed 4/4, with no horizontal overflow, console errors or page errors. Parent inspected desktop/mobile screenshots for both runtimes. See `validation/collection/2026-10-02/ui-5e0bdd3/manifest.json` for hashed build, verdict, screenshot and audit evidence.

The first desktop home overflow verdict is retained. A fresh DOM probe and unchanged repeat passed; transient initial rendering is only an inference. Opening home invokes its existing bootstrap and automatic scheduler tick: one synthetic Telegram-scoped keyword matched local content, with no external attempts and no new items. Thus home verification includes an isolated database write; source/jobs checks are read-only. Display fixtures are not online-source evidence. The existing utility dashboard OG-card note is retained.


## T17 review correction — 6acbd26

The original 52a16ea timed receipts, 5e0bdd3 full 535-test/build/UI receipts, and original gateway log remain unchanged. Review found that the old WeChat 80-row replay also matched direct external IDs, so that result does not independently prove canonical-URL matching. The old 331 total exactly checked the 330 Telegram IDs but only counted the RSS row; it does not establish opaque RSS identity preservation.

The correction changes only the offline reliability/load harness and their tests plus the owning gateway test. It requires the combined `{pages: ["1", ..., "330"], fault: ["001"]}` reference against actual scoped rows, stores both input and collected sets, and rejects an equal-count RSS substitution. WeChat now uses stored `legacy-1..80` and incoming `incoming-1..80`, records actual returned and retained internal IDs, and retains real PostgreSQL EXPLAIN/timing evidence. Cleanup independently attempts every top-level owned closer, records failures, always persists the report, and returns nonzero on cleanup failure. A child-process failure injection verifies that contract. The gateway test captures and asserts exactly its expected invalid-entry warning; production logging is unchanged.

New focused evidence targets committed source `6acbd26fc2a80dcf3dc286ddc972fc86d6178d0d` on Node v24.16.0, Windows x64. All five exit codes are zero; every infrastructure report records `clean-commit` and an empty `cleanup_errors` array. The business source and timed scenario loop are unchanged; the 52a16ea timed results remain historical evidence for those bytes, not a fresh timed run of the corrected harness. Serial P95 and half-hour media dispatch threshold misses, live 72h/7d, 24h endurance, unknown application memory budget and real Telegram quality remain as stated above.


| Correction-SHA check | Result | Evidence directory |
| --- | --- | --- |
| Native PG/MinIO quick reliability | 331 exact source/ID references, 0 missing/duplicates, 0 paid calls, 4 local fake model calls; 30.199 s | `reliability-1791164197944` |
| 100-source burst | 2,000 exact IDs, replay adds 0; 7.256 s | `load-100-1791164279221` |
| 1,000-source burst | 20,000 exact IDs, replay adds 0; 25.063 s; first-round P50/P95 2.855336/5.079555 s | `load-1000-1791164286687` |
| Registered validator file | 11/11, including opaque RSS substitution and cleanup rejection child | `checks-6acbd26/validators.log` |
| Full gateway suite | 127/127, 1.140 s runner; empty stderr and no escaped invalid-entry event | `checks-6acbd26/gateway.log` |

The quick run covered 2026-10-05 01:36:37.944–01:37:08.143 UTC. Its WeChat lookup returned exactly 80 legacy rows for 80 disjoint incoming IDs, retained the same internal IDs, and inserted zero replay rows. PostgreSQL's actual plan returned 0 rows from the external-ID index and 80 from `items_source_wechat_url_idx`; lookup 5.2541 ms, existing batch 168.6899 ms. Fresh input still returned zero history rows and inserted 80. `history-wechat-identities.json`, `history-wechat-plan.json`, `reference.json` and `collected.json` retain the independently inspectable proof.

The four new owned containers were confirmed absent after cleanup; the reserved UI database container remains present and was not changed. `checks-6acbd26/evidence-audit.json` records exact IDs and the preserved original gateway-log blob. The committed `timedScenarios` function is byte-identical to 52a16ea (Git blob comparison, avoiding checkout line endings); `source-scope.json` records its hash and the intervening source paths. Full npm/build/Python and the long timed profile were not rerun for this harness/test-only correction. Their older receipts keep their original SHA and all stated limits. Native quick-run RSS was 181,088,256 bytes; the PostgreSQL cache-inclusive cgroup again reached its 512 MiB peak without OOM. Neither establishes the pending application budget or endurance gate.
