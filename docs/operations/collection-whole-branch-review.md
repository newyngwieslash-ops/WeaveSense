# Final source re-review — 1e260c4fe435d6b2cdf0d8d70c8b7e6f40bfe664

Date: 2026-10-05. Scope: the single I3-only corrective commit from `9673350409c06167a1a424428c17a8085cc1c384` to `1e260c4fe435d6b2cdf0d8d70c8b7e6f40bfe664`. This section supersedes the current verdicts below; earlier reviews and reproductions remain preserved as history.

**C/I/M: 0 / 0 / 1.** I1, I2, I3 and M2 are closed. The only retained finding is M1, containing unresolved DEP-01/DEP-02 dependency debt under the previously documented merge triage.

**Ready to merge? Yes — source review gate approved.** No further source correction is required by this review. Final merge completion still depends on the parent's pending full validation and release/package/image evidence being bound to this corrected source (or a later evidence-only commit with verified source invariance). This is not a claim that those pending gates have already passed.

**Production promotion: No.** The dependency and named live-source, endurance, capacity, budget, backup and operational gates in the original review remain open. Source approval does not authorize or certify production promotion.

## I3 and I2 closure

**I3 closed:** `workers/telethon/server.py:241`–`:246` rechecks the current shared cooldown and connected/ready account state after successful awaited storage initialization and immediately before entering `download_media_to_store`. A newly established cooldown returns the existing 429 with current Retry-After; a disconnected or unavailable account returns the existing 503. There is no intervening await between these new checks and entry into the download helper. The six production lines close the demonstrated storage-setup admission interval without changing the media gate, initialization caching, pre-setup checks, native cancellation ownership or Telegram lifecycle.

The new regression at `workers/telethon/test_history.py:208` exercises all three concrete interleavings through actual request/history functions: history establishes FloodWait during blocked native setup, history marks the account unavailable, or the client disconnects. It verifies 429/503, remaining Retry-After, zero entity/message/download/upload work after setup, released media ownership and retention of the successfully initialized storage client. After simulated account/cooldown recovery, the request succeeds at the same `telegram/channel/101` key without another bucket probe. This checks both refusal and subsequent recovery, rather than merely asserting the added conditional.

**I2 now fully closed:** Combined with the preceding reviewed correction, configured storage can recover after transient initialization failure through bounded serialized requests; text history and passive health remain independent; cancellation retains native setup ownership; and successful storage recovery no longer uses stale Telegram admission state. No further Critical or Important regression was established in this two-file follow-up.

I1 and M2 remain closed from the previous re-review. M1 triage remains unchanged because this commit changes no dependency or reachability fact. Existing native SDK hard-wall and process-local serialization ceilings remain documented limitations, not new guarantees of this patch.

## Evidence and review limits

Read only the appended I3 section of `.superpowers/sdd/final-fix-report.md` and the supplied `review-9673350-admission-fix.diff`, once. The complete two-file patch contains six production lines and 71 test lines. No old whole-branch package, unrelated plan/task report or successful broad-suite log was reopened.

The retained pre-fix command runs the one new regression with three failing subcases: all three incorrectly returned 200. The released-source full Python command is reported as exit 0, **29/29 tests, 1.483 seconds, no skips**, covering the new cases plus prior storage, pagination and native upload/file/slot ownership tests. Both commands use the existing offline wrapper, Python venv and `-B`. The report also records clean whitespace validation. These supplied focused results support the inspected fix; I did not rerun already-green suites or make another executable probe.

The parent's full checks at 9673350 remain historical for that revision. The parent is holding 1e260c4 source frozen and will refresh full original checks, build, actual corrected images and artifact bindings after this code approval. Old 17b91d7/9673350 results must not be presented as already verifying the final source. Any later source change requires corresponding verification; evidence-only changes may retain source results only with an explicit invariance check.

No source, Git/index/HEAD, business/evidence file, configuration or resource was changed in this re-review. Only this ignored report was updated. No service start, account/provider/model request, external message or production action occurred.

**Final source assessment: Approved.** Continue the already planned exact-source validation and evidence refresh; retain M1 and all separate production-promotion limitations.

---
# Corrective-batch re-review — 9673350409c06167a1a424428c17a8085cc1c384

Date: 2026-10-05. Scope: the single six-file corrective commit from `5d5d6174e702a8dcd0357cbdfffca9eb3e630011` to `9673350409c06167a1a424428c17a8085cc1c384`. The original whole-branch review below remains the architectural review input; this section supersedes its current finding counts and closure status.

**C/I/M: 0 / 1 / 1.** I1 and M2 are closed. The original missing-storage-recovery mechanism in I2 is implemented, but one Important regression in its new asynchronous admission sequence must be fixed before I2 can fully close. M1 (DEP-01 and DEP-02) remains unchanged tracked debt.

**Ready to merge? With fixes — source gate not yet approved.** The remaining source issue is I3 below. Parent reports the full original npm, gateway, Python, TypeScript and Go checks at 9673350 all exited 0; its build/image refresh has not started. The historical 17b91d7 results do not certify these new source changes.

**Production promotion: No.** Dependency and the previously enumerated live/operational gates remain open, independently of this correction and of any refreshed offline checks.

## Closure assessment

- **I1 closed.** `src/lib/server/telethon.ts:133`–`:137` captures non-success status and Retry-After before body consumption. The outer catch at `:176` preserves that received failure through reset/cap/deadline. Clearing the temporary failure only after successful consumption allows the existing parser/FloodWait logic to choose the later deadline. Successful-response body failures retain their transport classifications. Added actual-client tests cover 200/429/503 against reset/cap/timeout, safe messages and cancellation. The scheduler regression covers 429/503 reset/timeout, persisted source/job cooldown equality, preserved backfill progress, and zero new history calls from immediate manual/scheduled attempts. No per-caller workaround or unrelated scheduler change was introduced.
- **I2 original root cause corrected, final closure withheld for I3.** `workers/telethon/server.py:83` now provides a shared, single-attempt setup path used by startup and media requests under the existing media gate. Initialization runs off the event loop, successful clients are reused, and cancellation retains native setup ownership until it settles. The new tests meaningfully cover first-failure/later-success, serialized setup/upload, passive health, continued history, repeated cancellation, queue timeout and sanitized persistent failure. The existing SDK hard-wall limitation is acknowledged rather than concealed. However, the request's Telegram admission state is now checked before an awaited storage operation and is not revalidated afterward.
- **M2 closed.** `src/routes/nodes.tsx:60`–`:61` now distinguishes unconfigured/unauthorized public windows, explicit Feed windows, configured-worker outage/cooldown and authorized-only history backfill. This resolves the fallback guidance identified by the original finding.
- **M1 retained.** The batch changes no dependencies, lock, image recipe or advisory reachability facts. The original independent decision remains: no prerequisite dependency upgrade for the isolated merge gate, but DEP-01/DEP-02 are unresolved and require the recorded maintenance/verification before production promotion.

## Remaining Important finding

### I3 — Recheck Telegram admission after awaited storage recovery

**Location:** `workers/telethon/server.py:233`–`:241`, particularly `await initialize_storage()` at `:238` followed by `download_media_to_store` at `:241`.

**Root cause:** `handle_media` checks the shared cooldown and account readiness, then awaits native MinIO initialization while holding only the media gate. History intentionally remains independent and can establish a FloodWait during that wait. When setup completes, the media request immediately starts Telegram resolution/message/download work using the stale pre-setup admission decision. The unchanged `download_media_to_store` begins with `resolve_channel` and `client.get_messages` and has no intervening cooldown check. Account connection state can likewise change during this new await.

**Impact:** A legitimate history FloodWait can be bypassed by a media request that was waiting for storage recovery. This contradicts the shared-account cooldown contract and can worsen Telegram rate limiting. The new storage recovery is useful, but the state must be checked at the point where it proceeds to account work.

**Independent narrow reproduction:** Used the existing offline environment wrapper and Python test fixture objects, with `-B` to avoid bytecode writes. The real `handle_media` waited inside a dummy Store's `bucket_exists`; while that native setup was blocked, real `history` received a fake Telethon `FloodWaitError(capture=30)`. After releasing storage setup, the media request used the actual `download_media_to_store` with dummy message/bytes/storage. Result:

```json
{"history_error":"flood_wait","history_wait":31,"media_status":200,"account_calls":[{"media_request_while_cooling":31}]}
```

The request therefore made `get_messages` while 31 seconds of shared cooldown remained. All objects and bytes were synthetic; no socket listener, Telegram/MinIO service, live account, provider, model or database was used.

**Minimum fix:** After initialization has completed and before entering `download_media_to_store`, revalidate the current shared cooldown and connected/ready account state. Return the existing 429 plus current Retry-After, or the existing unavailable response, as appropriate. Keep the pre-initialization admission checks if they avoid pointless setup during an already-known cooldown. Preserve the existing media gate, setup caching and cancellation ownership; no broader lifecycle redesign is needed.

**Required focused regression:** Extend the storage recovery concurrency fixture: hold setup, make history establish FloodWait, release setup, and assert the pending media request returns 429 with remaining Retry-After and performs no subsequent Telegram message/download call. Verify account unavailability during setup is also respected. Existing successful recovery and native-owner checks should continue passing.

This is the complete remaining corrective finding batch; no other new Critical/Important/Minor source issue was established in the six-file correction.

## Validation and scope limits

Read the full `.superpowers/sdd/final-fix-report.md` and the supplied 535-line corrective diff once in bounded sections. The report preserves three meaningful pre-fix REDs, intermediate 17/18 and 27/28 test-expectation corrections, final 18/18 Node and 28/28 Python focused GREENs with no skips, and whitespace verification. I did not rerun those successful suites. The named concrete integration risk above required inspecting only the unchanged media download helper and running one isolated in-memory concurrency probe; the original 3 MB package and broad plan/task reports were not reopened.

Parent owns the full validation and actual corrected images. Its latest update reports all full original suites at 9673350 passed (npm 107.884 seconds), with the exact-source snapshot prepared and build/image not started. These are parent-reported results, not independent reruns. All final gates must be bound to the final corrected source; any follow-up source fix makes 9673350's images/tests historical for the affected behavior. This re-review neither claims completion of that pending evidence gate nor treats old 17b91d7 source invariance as extending across this code commit.

Only this ignored review report was modified. Source, Git/index/HEAD, business data, evidence and real resources remained unchanged. The original review and all production limitations are preserved below.

---
# Independent final whole-branch review

Baseline: `c49829f3eea2a6631cd9b61fc1a46e3f9c2bf7c4`  
Reviewed HEAD: `5d5d6174e702a8dcd0357cbdfffca9eb3e630011`  
Runtime/evidence revision: `17b91d79e3397dae88d7dd816d0cb667570ce99d`  
Review date: 2026-10-05

**Ready to merge? With fixes.** Two Important recovery defects require correction and focused regression coverage before merge. No Critical finding. Two Minor findings are recorded below; M1 contains both DEP-01 and DEP-02. Prior task approvals were not treated as evidence that these cross-task paths were correct.

**Production promotion: No.** Closing the code findings will not close the explicitly pending live-source, endurance, capacity, dependency and operational acceptance gates.

## Strengths

- Source completion now has a coherent transaction boundary: the claimed source is locked before item/media writes, stale tokens fail before writes, and source progress, continuation, validators and job completion commit together. Replay repairs missing media without duplicating items. Failures preserve the previous checkpoint.
- Identity work addresses the actual reference graph rather than just rewriting displayed IDs. Telegram aliases preserve UUIDs when possible; ambiguous content/date groups refuse merging; dependent media, extraction, notes and agent references are considered. The native checkpoint codec is pinned, bounded, rejects unsupported states, preserves evidence/prose/budget facts, and has an SDK-generated resume test plus CLI framing checks.
- Public HTTP retains DNS/address validation, pinned transport and per-redirect validation. Total deadlines cover resolver, queue, headers and body; caps cancel unread bodies; secrets do not become error messages. Media and storage paths already demonstrate the correct received-status/cooldown preservation pattern that history currently misses.
- Persistent retries and manual admission share cooldown state. Media has finite attempts, explicit replay, immutable reserved object keys, lease/token fencing and atomic display updates. Extraction defers unavailable MIME/bytes without consuming model attempts and checks readiness before LIMIT, including the first-four-target ceiling.
- Telegram text history is separated from attachments, ascending traversal and service-only pages preserve progress, account recovery is single-owner, health does not log in, and FloodWait is shared with media. Upload cancellation retains the temporary file and slot while a native SDK call is still using them; its hard-wall limitation is documented.
- WeChat distinguishes request availability, observed primary content progress, provider-independent publication time and body completeness. Cached paid bodies do not refresh primary freshness or trigger new spending. Restart/outbox tests preserve conservative reservations and require durable app enqueue before ACK.
- Backup/release work uses authenticated whole-generation encryption, separate keys, exact resource identities, stopped-writer checks, SQLite backup APIs, restore-to-new-target refusal, hashes and schema checks. The POSIX permission fix reuses the existing helper. Service environment routing, separate image build contexts and source-package exclusion rules keep private state out of delivered artifacts.
- Tests exercise real exported paths and SQL transactions, not only helper-shaped expectations. Existing broad checks, real PostgreSQL/MinIO fixtures, native checkpoint resume, fixed Linux images and both desktop/mobile dev/built render evidence provide useful complementary coverage. The evidence distinguishes measured results from pending goals and retains failed attempts.

## Findings

### Critical

None found.

### Important

#### I1 — Preserve history HTTP status and Retry-After before reading the body

**Location:** `src/lib/server/telethon.ts:132` and `:133`; error normalization at `:172`.

**Root cause:** `fetchTelethonHistory` waits for `readCapped` before constructing the error details from the already-received response headers. A reset, size rejection or deadline during that read reaches the outer catch as a transport/body error. The known HTTP status and Retry-After never enter the thrown `CollectionHttpError`.

**Impact:** A Telegram history response that has already requested a long cooldown can be recorded as an ordinary network failure. The shared scheduler then has no upstream retry timestamp to persist and uses its shorter generic retry schedule; subsequent manual or scheduled collection can run before the received cooldown. This breaks the durable Retry-After/FloodWait contract even though the sibling attachment/storage implementations preserve it.

**Independent narrow reproduction:** An offline environment plus a middleware-only module loader called the actual `fetchTelethonHistory('channel', '0')`. Global fetch was replaced with a fixture that accepted only `http://worker.fixture/v1/history`, returned status 429 or 503 and `Retry-After: 172800`, and errored its in-memory response stream. No listener, account, provider, database or model was used. Both cases returned:

```json
{"receivedStatus":429,"receivedRetryAfterSeconds":172800,"errorCode":"network_error","errorStatus":null,"errorRetryAt":null}
{"receivedStatus":503,"receivedRetryAfterSeconds":172800,"errorCode":"network_error","errorStatus":null,"errorRetryAt":null}
```

**Minimum fix:** Reuse the received-failure approach already present in `fetchTelethonMedia` and signed storage: capture non-success status and validated Retry-After before body consumption, preserve that failure if consumption fails, and still combine a successfully parsed FloodWait with the header using the later deadline. Keep successful-response body failures classified as transport errors. Do this once in the shared history client, without per-caller workarounds.

**Required focused check:** Exercise actual history 429/503 with a reset/timeout error body and a long Retry-After; assert retained code/status/retryAt. Include the scheduler persistence/admission seam so immediate manual and scheduled retries make no history request before that timestamp. Existing history tests cover normal error bodies and cancellation, while the body-failure/cooldown matrix currently covers media/storage instead.

#### I2 — Recover attachment storage after a transient initialization failure

**Location:** `workers/telethon/server.py:68` (`build_minio`), `:75`–`:80` (initial bucket probe failure returns None), `:211`–`:212` (permanent unavailable branch), and `:437`–`:439` (single startup initialization).

**Root cause:** Startup invokes `build_minio()` once. That helper performs network bucket initialization and returns None on any exception. No later media request or background recovery path rebuilds a missing client. Telegram account reconnects do not alter this storage state.

**Impact:** With valid configuration, a temporary MinIO outage or cold-start readiness race leaves `/v1/media` returning 503 after MinIO has recovered. The app can continue claiming attachments because its own endpoint/token/storage configuration is present; those attempts can exhaust the finite queue cycle. Health reports attachments unavailable, but neither later requests nor explicit queue replay can recover the worker without a process restart. This is a missing recovery path in the newly delivered durable attachment workflow, not a request to make health perform network I/O.

**Evidence:** Traced initialization, the media admission branch and all assignments/callers in the supplied diff. Existing Python tests substitute an already-created Store or return None permanently; account reconnect tests deliberately stub `build_minio` and therefore do not cover initial storage failure followed by recovery. This finding is established by control flow; no live MinIO/account reproduction was attempted.

**Minimum fix:** Allow bounded, serialized reinitialization when storage is configured but the initial client is unavailable, using the existing media ownership/admission path or an equivalently small storage recovery path. Keep absent configuration unavailable, health passive, bucket setup idempotent, network work off the asyncio event loop, and native-call/file/slot lifetime rules intact. A readiness-only Compose adjustment is insufficient for the transient failure path.

**Required focused check:** With dummy storage and Telegram objects, make the first bucket probe fail and a later one succeed. Demonstrate that a subsequent media request stores the same locator key without restarting or reconnecting Telegram; concurrent requests must not create overlapping setup/upload owners. Text history must remain available during storage recovery, and persistent failure must remain bounded and sanitized.

### Minor

#### M1 — DEP-01 and DEP-02 remain unresolved dependency debt

**Locations:** `docs/operations/collection-recovery-release-acceptance.md:72` and `:73`; `validation/collection/2026-10-02/t18-dependency-audit-fix-wave.json:4`; packaging through `Dockerfile:6`.

**Root cause and impact:** The unchanged dependency lock retains brace-expansion 1.1.18/5.0.9 and js-yaml 4.3.1. The recorded audit reports two high-severity package findings. Brace-expansion arrives through development tooling that remains installed in the root image. js-yaml also belongs to the Start/plugin/xmlbuilder2 dependency path used by the Vite-based startup environment, so it cannot be dismissed as exclusively development-only. Crafted inputs to the vulnerable APIs can exhaust CPU/stack resources.

**Independent merge triage:** I do not require these pre-existing dependencies to be upgraded before this isolated implementation branch is merged. The reviewed product collection paths parse RSS/XML with their explicit parser and do not introduce a request-to-YAML or request-to-brace-expansion call path. The supplied dependency analysis likewise does not establish one. That limited reachability evidence supports retaining this as Minor merge debt, not downgrading the upstream advisory or claiming safety. This branch does not deploy production, and its production gate already remains closed. This decision does not inherit T18's rating.

**Minimum follow-up before promotion:** Validate compatible fixes for brace-expansion at least 1.1.21/5.0.12 and js-yaml at least 4.3.2, refresh the lock and audit, rebuild the actual image, and run the relevant build/start checks. Confirm actual entrypoint reachability; record any residual advisory explicitly. Do not suppress the audit warning or call triage a vulnerability fix. No new network audit or exploit payload was run in this review.

#### M2 — Node-page fallback guidance contradicts the new recovery behavior

**Location:** `src/routes/nodes.tsx:59`–`:60`; actual behavior in `src/lib/server/collectors/index.ts:139`–`:148`.

**Root cause and impact:** The node page still tells operators that Telegram falls back to t.me/s when disconnected. The new collector deliberately treats configured-worker connecting/unavailable states as retryable failures and preserves cooldown/backfill requirements. An operator investigating the new unavailable state is therefore told a fallback is happening when it is not.

**Minimum fix:** Update this short explanation to distinguish the supported public fallback cases from a configured worker's temporary outage/cooldown and explicit history backfill, which wait for recovery. Reuse the accurate capability wording already present elsewhere. This is a copy-only correction; no new test framework or behavior change is needed.

## Plan alignment and cross-task assessment

The implementation substantially follows the authorized collection-reliability scope: safer append-only migrations; indexed bounded identity lookup and explicit maintenance; atomic continuation; persisted retry admission; corrected RSS limits/validation/identity; connection recovery; deferred durable media; conservative WeChat fallback/spend/freshness; conditional validators; observable metrics; capability-aware source forms; offline acceptance fixtures; encrypted recovery and fixed release artifacts.

T14/T15 remain conditional named-site extensions and are legitimately deferred. Real RSS/Telegram/WeChat configuration will be supplied later through the UI; inventing live accounts or provider proofs would be outside this gate. Full implementation authorization supersedes historical plan-only wording. There is no reason to reopen finished tasks merely because live acceptance is still pending.

The two Important findings are integration gaps between otherwise well-tested shared components: response consumption versus retry persistence, and one-shot storage initialization versus durable queue replay. Their fixes should stay in the shared owning functions and add narrow regression checks. No schema redesign, added dependency or new subsystem is warranted.

The preserved 30-minute media/production admission windows are intentional and tested. The proposed two-minute media timing target and universal 120-second source P95 are not established; the evidence reports the serial-capacity tradeoff rather than relabeling it a pass. The 195-second Telegram reservation can reduce source work admitted into a tick. Fixed fixture images and successful small restores support candidate reproducibility and recovery correctness, not production-sized performance guarantees.

## Evidence and review limits

- Reviewed the supplied commits/stat/context package for baseline through HEAD, in bounded sections, tracing runtime and test contracts across the groups above. Recovered clipped sections where needed rather than generating another Git diff. Repeated fixture rows, raw logs and manifests were assessed structurally against their claims; prior successful broad suites were not rerun. The supplied brief and T18 review were inputs, not substitutes for independent code judgment.
- Parent's final original commands record npm 546, gateway 127, Python 25, TypeScript, cached Go count=1 and build passes at exact runtime revision `17b91d79e3397dae88d7dd816d0cb667570ce99d`. Parent independently verified runtime/source/lock/image-recipe invariance through reviewed HEAD `5d5d6174e702a8dcd0357cbdfffca9eb3e630011`; later changes are docs/evidence/public ZIP. I rely on that supplied binding and did not recalculate Git/resource hashes.
- Parent's final dev/built desktop/mobile checks and visual inspection are recorded. The first cold dev baseline divergence remains part of the evidence; unchanged warm comparison passed. I did not restart servers or repeat browser checks. This is not proof that every loading timing state is identical.
- The extra Windows pack copy interruption remains UNKNOWN: one owned process was stopped after its copy stall, with the incomplete result retained. The unchanged bounded retry, focused closure check and final package hash establish the delivered archive; they do not establish the cause of the stall. I found no justified speculative code patch from that observation.
- D/E ciphertext copies were actually restored by the existing fixture procedure and parent-verified: maximum restore 17.387 seconds, maximum observed snapshot age 56.913 seconds. D shares the observed C/D physical disk; E is a distinct disk, but both are on the same host. This is no off-machine disaster-recovery proof, continuous RPO proof or production-volume RTO proof. The archive's documented 256 MiB serialized ceiling remains relevant.
- Final root image `44c19ee6...` and Telethon image `2ca43a6c...` bind to runtime revision 17b91d7. Linux checks cover 148 Node and 25 Python cases and isolated role startup; Telegram intentionally remains unconfigured/unauthorized. The image ZIP and later documentation-inclusive public ZIP are distinct artifacts and must stay distinguished.
- Still pending: authorized WeChat 72-hour/7-day reference runs; 24-hour endurance; real Telegram image/audio quality; actual application/model/provider budget validation; application-memory budget; serial source latency and 1000-source fleet capacity; proposed two-minute cadence; real production pre-switch image inventory/rollback rehearsal; production-size restore and off-machine recovery; production backup scheduling/retention activation; dependency promotion gate. None is silently completed by offline fixture success.
- Review actions changed no source, Git index/HEAD, business data, evidence, real configuration or deployment. The only executable probe was the narrow all-in-memory history error-body reproduction described in I1. No live account/provider/model call, service listener, production read, external message, broad test rerun or automatic backup activation occurred. Only this ignored report was written.

## Final assessment

**C/I/M: 0 / 2 / 2** (Minor M1 explicitly contains DEP-01 and DEP-02).

**Ready to merge? With fixes** — close I1 and I2 with focused regressions and have this reviewer recheck the single corrective batch. M2 is a small copy correction suitable for the same batch. M1 may remain tracked for merge under the isolated scope, but must be addressed before production promotion.

**Ready for production promotion? No** — Important code defects, unresolved dependency vulnerabilities and the named live/operational acceptance gates prevent that conclusion. A clean corrective review will certify only the reviewed implementation/merge gate unless new, correctly bound acceptance evidence closes those separate requirements.
