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

The first command includes real wall-clock minute ticks and two serial source profiles, taking approximately 21 minutes. `--quick` omits those timed scenarios and reports them pending. It is a development check, not replacement evidence. On this Windows host use `node F:/nodejs/node_modules/npm/bin/npm-cli.js` for npm commands inside the offline wrapper, and `.venv/Scripts/python.exe` for Python checks.

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
- Three 100,000-row histories: RSS IDs, Telegram legacy aliases, and normalized WeChat URLs. Existing 80-entry batches return exactly 80 rows; fresh batches return zero unrelated rows and insert exactly 80. Each has an actual `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, timings and Node RSS samples.
- Real MinIO upload preceding a failed PostgreSQL completion transaction; extraction remains deferred until MIME/storage metadata commit; retry retains the object key; extraction then runs once.
- Native PostgreSQL SHA256 first-four extraction query with `LIMIT 1`, dead/cooling-only newest items, no fifth-target expansion, and an exact inclusive 15-minute extraction lease boundary in a pinned transaction.
- Actual production dispatcher at injected minute/half-hour timestamps: ingest, extract and automatic analysis keep their own windows. Real cron POST handler exercises PostgreSQL enqueue-before-ACK, failed ACK, persistent SQLite reopen and idempotent replay.
- Full timed run: actual cron POST source recovery at real 60-second ticks; 14 Telegram-history fixture sources with 45-second responses and test concurrency one, comparing ordinary 55-second and Telegram 195-second media reservations within the 720-second server / 750-second loop budgets. The Telegram media response waits 120 real seconds and verifies the real MinIO object. Production source concurrency remains nine; this test does not promise fleet capacity.

## Results and limits

Development evidence is preserved, including failing fixture attempts. These are not final committed-SHA release evidence. The latest pre-commit quick run and 100-source burst passed their deterministic assertions; final committed-SHA runs and full test/build/browser checks are recorded in the T17 implementation report after the controller commits the source.

The proposed media recovery threshold is **not met**: a retry can become eligible after 60 seconds, while the preserved ingest stage dispatches at the next half-hour window (1,800 seconds in the controlled scenario, 1,740 seconds after eligibility). Calling `ingestPending` directly is not counted as cron recovery. Timed serial profiles separately report whether due-to-start P95 exceeds 120 seconds; exceeded thresholds are not presented as passes.

Native Node peak RSS is process memory, not Docker-cgroup memory. PostgreSQL `memory.current`, `memory.peak`, `memory.stat` and `memory.events` refer only to its enforced container and include file cache. The development 300,000-row history run reached the 512 MiB cgroup peak; this does not establish application RSS under 70% of a container budget. The application has no enforced container budget in these native runs, so the application 70% resource gate is **unknown**, and 24-hour endurance is **pending**. Production resource limits are unchanged.

For live acceptance, record each permitted source's platform, interval, accessible reference IDs, initial range and upstream window. Run 10–20 sources for 72 hours, then 100+ for seven days. Keep inaccessible/upstream-limited samples in the report, explain missing IDs, and record paid costs conservatively. Offline completeness and a short resource sample cannot close those gates.
