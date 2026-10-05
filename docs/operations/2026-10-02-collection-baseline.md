# Collection implementation baseline

Recorded 2026-10-04. Integration input: `c49829f3eea2a6631cd9b61fc1a46e3f9c2bf7c4`; parent publishes the final task commit SHA. The historical plan-only restriction was superseded by explicit implementation authorization. No deployment or live collection is implied.

`7ee126f` merged the prior production-parity branch into main. `git merge-base --is-ancestor 0028a81 HEAD` succeeds. The historical remote tracking name is absent from this native worktree; the original commit object is present. No tree copy or replacement was needed. Main Telegram handle parsing and malformed JSON handling remain in the merged baseline.

| Capability | Code evidence | Offline evidence | Actual running image |
|---|---|---|---|
| SSRF, DNS pinning, bounded body | outbound-policy.ts / http.ts | focused outbound-policy tests | Unverified |
| Exact IDs and paging | cursor.ts / collectors/index.ts / workers/telethon/server.py | cursor + pagination + history checks | Unverified |
| Stage windows | stage-windows.ts / migrations/0021_stage_windows.sql | stage-windows tests | Unverified |
| Runtime DB guard | scripts/runtime-policy.mjs / src/lib/db.ts | baseline npm test | Unverified |
| Full body persistence | rss-parser.ts / scheduler.ts | content-integrity + rss tests | Unverified |
| Keyword classification and historical tagging | scheduler-outcome.ts / keyword.ts / scheduler.ts | keyword-outcome + scheduler-outcome tests | Unverified |
| Media types | media-kind.ts / media.ts | media-kind tests | Unverified |
| Isolation and recovery | readiness-offline.mjs / restore-policy.mjs / postgres-recovery-check.mjs | isolation + restore-policy tests | Unverified |

Root Compose references `loom-app:readiness-20260930-merged` for app and scheduler. This is a declared tag, not proof of running image content. Parent read-only Docker inspection found no current Loom containers; actual image IDs remain unverified.

Schema inventory: 20 root SQL migrations, numbered 0002 through 0021; opt-in auth migration 0001 is separate under migrations/auth. New collection migrations start at 0022 after checking for concurrent allocations; no deployed migration was edited.

T01 changes repair the missing scheduler-outcome test command with behavioral tests, add public Telegram handle tests, include collector Telegram checks in npm test, and expose Python history via `npm run test:telethon-history`. offlineEnv now always applies safe defaults despite enabled parent flags, sets development runtime mode, and pins model configuration to an explicitly missing temporary path. The runtime allowlist drops all unknown credentials. Test-only explicit overrides remain supported; callers must supply synthetic values or isolated resource addresses.

Validation is offline only. Dependency-install and Python-environment results are recorded in `.superpowers/sdd/task-01-report.md`; incomplete installs and skipped tests are never counted as passes. No real database migration, model call, network collection, production config read, or secret inspection was performed.

Final offline baseline: combined npm coverage 412/412, zero skips. The complete npm rerun passed 387/387 main tests and 24/25 validation repro tests; R01 was then given the same explicit synthetic model fixture and the full final repro stage passed 25/25. This is combined coverage; a single all-green npm test invocation will be repeated at final integration. Gateway 116/116, Python history 5/5, focused collection tests, typecheck and parent snapshot build pass. Actual running images and live acceptance remain unverified.
