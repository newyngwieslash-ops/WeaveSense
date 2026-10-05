# Final-review corrective batch report

Date: 2026-10-05. Base HEAD supplied by controller: `5d5d6174e702a8dcd0357cbdfffca9eb3e630011`.
Worktree: `C:/Users/yi'da'dui/.codex/worktrees/collection-reliability/WeaveSense`.
Status: I1, I2 and M2 implemented; focused checks pass. **SOURCE RELEASE**: source edits complete; controller owns Git/index/commits, full gates and exact-source/image binding. No Git mutation was performed.

## Scope and flow

Read the entire final review and binding Global Constraints before editing. Changed exactly six owned files:

- `src/lib/server/telethon.ts`: capture non-success status and validated Retry-After before reading history body, preserve the received error through read reset/cap/deadline; after successful consumption retain existing parsed error/FloodWait handling and later-of-header/body deadline.
- `src/lib/server/collectors/telegram.test.mjs`: actual exported history client 200/429/503 x reset/cap/timeout matrix, safe errors, long deadline and body cancellation assertions.
- `src/lib/server/collection-retry.integration.test.ts`: actual collector/scheduler/SQL persistence and manual/scheduled admission regression for 429/503 x reset/timeout with 48-hour Retry-After; preserves cursor, backfill boundary and has_more.
- `workers/telethon/server.py`: one shared storage initialization helper used by startup and authenticated, validated media requests. Both callers hold the existing media gate, run bucket setup off the asyncio loop, and retain native task ownership through cancellation. Later requests recover a missing configured client; absent configuration stays unavailable; health remains passive.
- `workers/telethon/test_history.py`: startup failure followed by successful serialized media recovery; native setup cancellation/deadline ownership; absent configuration and repeated sanitized bounded failures. Existing native upload/file-lifetime cases remain unchanged and pass.
- `src/routes/nodes.tsx`: distinguishes unconfigured/unauthorized public windows and explicit Feed windows from configured-worker outage/cooldown recovery and authorized-only history backfill.

Traced all `fetchTelethonHistory` references: the production caller is `telegramAdapter.fetch` in `collectors/index.ts`; it wraps the original metadata in CollectorBatchError, then `runSourceJob` calls fenced `failSourceClaim`. Existing `retryFailure` deliberately classifies any valid upstream retry timestamp as `rate_limited`, including HTTP 503; this behavior is retained. Both `runSourceJob` manual admission and `tickDueSources` use persisted cooldown. No caller-specific workarounds or scheduler changes.

Traced every production storage initialization/assignment: `build_minio` remains the single synchronous bucket probe/create implementation, with existing connect=5s/read=20s and retries disabled. `initialize_storage` is called only while `media_gate` is owned (startup or media request). Successful initialization is cached. Each failing request makes at most one setup attempt; there is no background retry loop. Existing bucket-exists guard prevents repeated creation on initialized storage. Existing download/upload implementation, temporary file lifetime, immutable key and cancellation behavior are unchanged.

## RED evidence (before source fixes)

All logs below are retained under `.superpowers/sdd/`; no secret-bearing parent configuration is inherited by runtime checks.

1. `node scripts/readiness-offline.mjs -- node --test --test-name-pattern='history received failures' src/lib/server/collectors/telegram.test.mjs`
   - `final-fix-red-history.log`: 1 test, 0 pass, 1 fail; actual `network_error` versus required `rate_limited` after received 429/reset. 959.6074ms.
2. `node scripts/readiness-offline.mjs -- node --experimental-strip-types --test --test-name-pattern='history body failures' src/lib/server/collection-retry.integration.test.ts`
   - `final-fix-red-admission.log`: 1 test, 0 pass, 1 fail; actual scheduler result `network_error`, not the received HTTP failure. 2841.8198ms.
3. `node scripts/readiness-offline.mjs -- .venv/Scripts/python.exe -m unittest discover -s workers/telethon -p test_history.py -k storage`
   - `final-fix-red-storage.log`: 4 tests, 3 failures in new cases, 2.028s. No setup attempt on subsequent configured media request; native-owner test received immediate 503; startup probe ran on asyncio thread (the fixture assertion was caught by the existing safe build_minio failure path, leaving probe count zero).

Initial post-fix attempts are also retained, not overwritten:
- `final-fix-green-node.log`: 17/18. The new integration assertion initially expected stored `http_error` for 503, but the existing scheduler contract correctly records `rate_limited` when retryAt is present. Corrected test expectation only after reading retryFailure.
- `final-fix-green-python.log`: 27/28. Installed urllib3 normalizes `retries=False` into `Retry(total=False, ...)`; corrected the test to inspect its total setting while accepting either representation. No runtime change was needed for either mismatch.

## GREEN evidence on released source

Commands were launched independently in parallel; output redirection retained complete logs. PowerShell captured `$LASTEXITCODE` before displaying log tails and returned that exit status.

1. `node scripts/readiness-offline.mjs -- node --experimental-strip-types --test src/lib/server/collectors/telegram.test.mjs src/lib/server/collection-retry.integration.test.ts`
   - `final-fix-green-node-2.log`: exit 0; **18/18 pass**, 0 fail/cancel/skip, 8373.7727ms.
   - New history test executes 9 status/body combinations; existing parsed header/FloodWait tests still assert the later of 60s and 172800s in both directions.
   - New scheduler test executes 4 received-failure combinations, asserts persisted source/job retry equality and unchanged backfill progress, then verifies immediate manual retry and scheduled tick make no additional history call. All 4 original history requests occur exactly once.
2. `node scripts/readiness-offline.mjs -- .venv/Scripts/python.exe -m unittest discover -s workers/telethon -p test_history.py`
   - `final-fix-green-python-2.log`: exit 0; **28/28 pass**, 1.766s; no skips. Separate offline `--version` check returned Python **3.12.14**.
   - Dummy first bucket probe fails; subsequent concurrent requests share one recovered client and produce the same history locator's `telegram/channel/101` object key. Probe/create/peak-native-owner counts are 2/1/1, with exactly one Telegram connect and no reconnect/disconnect before shutdown. Health does not probe; history succeeds while setup is blocked.
   - Timeout and repeated external cancellation retain media gate until native setup finishes; a queued request expires without a second setup. Existing upload tests still retain file and slot across cancellation. Repeated permanent failure has one bounded SDK attempt/request, safe response/log text, and leaves Telegram text history ready.
3. `git diff --check`: exit 0, no whitespace errors; only Git's existing LF-to-CRLF notices. Git usage was read-only (`diff`, `diff --stat`, `diff --check`).

All runtime checks use the existing offline environment allowlist. JS uses replaced fetch / fixture public transport and an isolated in-memory PGlite database. Python uses only dummy Telegram/MinIO objects. No live account, provider, model, production service, real configuration or external message was touched. No new dependency, migration, budget/window change, image build, broad build/typecheck or full app suite rerun.

## Self-review / remaining limits

- Received failure capture lives only until body consumption completes, so valid parsed FloodWait continues to win when later; successful-response body failures keep transport/cap/timeout classification. Retry-After parsing reuses the existing validator.
- Storage setup shares the upload's existing native SDK cancellation limitation: a Python native thread cannot be killed at the asyncio deadline. A cancelled owner retains the slot and waits for bounded SDK IO to settle; hard-wall guarantees still require process isolation. The new `ponytail:` comment states this ceiling. No orphan native setup/upload/file is knowingly released.
- Serialization is process-local as before; this does not add multi-replica storage ownership. Bucket setup retains the existing bucket-exists/create guard and sanitization; concurrent in-process requests do not overlap owners.
- Persistent storage failure remains 503 and uses the existing app retry cycle; there is no automatic queue-budget reset or account reconnect. Long native IO can delay the owning request beyond the async deadline, as documented for upload already.
- M1 is deliberately retained: DEP-01/DEP-02 dependency debt and its production-promotion gate remain unchanged. No blind dependency upgrade, safety claim or vulnerability closure.
- This is a corrective source/focused-regression handoff, not a production promotion. Existing live-source/endurance/capacity/backup/dependency gates remain pending. Parent must bind its final full validation and images to the frozen corrected source.

**SOURCE RELEASE — no further source edits pending from this worker.**

---

## I3 follow-up batch — post-storage Telegram admission (2026-10-05)

Parent released source writes after all frozen `9673350409c06167a1a424428c17a8085cc1c384` full checks completed. Read the complete corrective re-review at the top of `final-review.md`. I1/M2 stay closed; this batch addresses only I3, the remaining I2 admission gap. Earlier evidence above and parent's full967 npm548/gateway127/Python28/TypeScript/Go evidence remain historical and were neither overwritten nor rerun here.

Owned source changes in this follow-up are exactly:

- `workers/telethon/server.py`: six added lines recheck current shared cooldown and connected/ready account state after awaited successful storage initialization, immediately before calling `download_media_to_store`. Returns existing 429 with current Retry-After or 503 unavailable. Pre-setup admission checks, media gate, native task ownership, setup caching, error handling and lifecycle are preserved.
- `workers/telethon/test_history.py`: one regression with three concurrent subcases. Hold dummy native bucket setup while actual history establishes FloodWait or network-unavailable state, or while the fake client disconnects. Release setup and assert expected 429/503, current Retry-After, and zero subsequent entity/message/download/upload work. Successful storage initialization remains cached; after fixture account readiness/cooldown recovery, the same request stores `telegram/channel/101` without a second bucket probe.

### RED before six-line runtime fix

Exact command:

```text
node scripts/readiness-offline.mjs -- .venv/Scripts/python.exe -B -m unittest discover -s workers/telethon -p test_history.py -k storage_recovery_rechecks
```

Retained log: `.superpowers/sdd/final-fix-i3-red.log`. Exit **1**; ran **1 test with 3 failing subcases**, 1.073s. All three stale-admission requests incorrectly returned 200: expected 429 for history FloodWait, 503 for history network-unavailable, and 503 for disconnected client. This reproduces the review finding using actual request/history functions and dummy native IO, not a helper-shaped assertion.

### GREEN on final released I3 source

Exact command:

```text
node scripts/readiness-offline.mjs -- .venv/Scripts/python.exe -B -m unittest discover -s workers/telethon -p test_history.py
```

Retained log: `.superpowers/sdd/final-fix-i3-green.log`. Exit **0**; **29/29 tests pass**, 1.483s, no skips. Includes all prior pagination, storage recovery, native upload/file/slot ownership and repeated-cancellation checks, plus all three new admission subcases. Both commands use the existing offline allowlist, Python3.12 venv and `-B`; no real service/configuration/account/provider/model requests. PowerShell captured `$LASTEXITCODE` before displaying log tails and returned that status.

Read-only `git diff --check`: exit 0, only normal LF-to-CRLF notices. Reviewed source diff: six production lines plus 71 test lines. Parent-owned `public/zhishi-loom-source.zip` already appears modified in the shared worktree; this worker did not write, restore or stage that file. No Git mutation, Node/full-suite/build/image rerun or helper/lifecycle redesign.

Self-review: the post-setup check and initial entry into download run without an intervening await, closing this new storage-recovery stale-admission interval. The existing account/history concurrency and native SDK hard-wall ceiling remain unchanged; no broader guarantee about every later Telegram await is introduced. M1 dependency and all production-promotion limitations remain open.

**SOURCE RELEASE — I3 follow-up source and report complete; no further writes pending from this worker.**
