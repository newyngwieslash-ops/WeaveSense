# Implementation and verification record — 2026-10-07

The implementation keeps the existing application, SQL ledger and Go/Eino module.
OpenCode is an optional, disabled corpus-research executor. No production feature
switch was enabled, no deployment database was migrated and no paid model was called.

| Plan tasks | Delivered boundary | Evidence / limit |
| --- | --- | --- |
| 1–3 | Separate queue/execution deadlines; frozen Skill bytes; explicit missing/mismatched Skill failures | Existing Eino contracts, deadline and Skill regressions; Windows Go tests and Linux race tests |
| 4, 6 | Independent review contract; authored defect fixtures; preregistered bounded A/B/C evaluation and separate blind scoring | Fixture checks are not model-quality measurements. Live acceptance remains false pending actual observations and independent labels |
| 5 | OpenCode 1.3.13 binary, OpenAPI, configuration and protocol probes | `runtime-lock.json`, `protocol.fixture.json`; dispatch replay is not established as idempotent |
| 7–10 | Immutable candidates, full evidence metadata, provider ownership, role grants/budgets and independent HTTP Reviewer | PGlite transactions and real PostgreSQL lock/fault/migration checks; no model execution inside the jobs transaction |
| 11–13 | Trusted Go corpus/model bridge, one-slot Linux runtime and separate OpenCode worker | Actual native runtime/bridge and host-ledger integration; default-deny tools and verified network/process boundaries |
| 14–15 | Host-controlled atomic publication; drafts/review/status/cancellation UI | Eino and native OpenCode dev/built browser scenarios; blocked draft never appears as its own published note |
| 16 | Regression, concurrency, fault, migration and browser checks | `baseline.md`, `e2e.fixture.json`, `race.fixture.json`; all supplier responses are local fakes |
| 17 | Optional Compose profile, credential separation, operational drain/reconcile/rollback instructions | Default disabled. Deployment-host isolation and actual production rollback have not been exercised |

The main safeguards are shared: all successful governed publication uses the same
candidate/review/evidence guard; model sends require a committed `send_once` fact;
uncertain sends retain their reservation and cannot be automatically replayed.
Review recovery reuses saved candidates and exact ACK envelopes. Cancelling a sent
request does not establish zero spend. Provider changes affect new routing only.

The integration checks caught and repaired two real cross-component defects:
the production SSR build emitted an undefined export during Nitro secondary
chunking, and Go omitted an empty successful response's evidence array. The fixes
use one Nitro build option and Go's existing `omitzero` JSON option respectively.
Final OpenCode tool counts also come from the host RPC ledger, not runtime claims.
The server build now emits one roughly 3.1 MB bundle; client splitting remains intact.

Reused components include the existing queue/run/completion transactions, budget
tables, retrieval, Go HTTP/MCP dependencies, packaged Skills and knowledge page.
There is no new SDK, vector database, plugin registry, workflow engine or agent fan-out.
Forward migrations 0022–0025 preserve historical rows and are not down-migrated.

Operational entry points are documented in
[`opencode-research.md`](../../../docs/operations/opencode-research.md).
The production-shaped Compose syntax was checked using a credential-free copy;
the actual external `minio-init.env` is absent on this checkout, so this is not a
claim that the whole deployment configuration is ready. The exact release decision
is [`decision.md`](decision.md): offline feasible, live adoption not accepted.

Final release checks: `npm test` passed all 489 tests across six groups, with
zero failures or skips; `npm run typecheck` passed; `npm run lint` reported zero
errors and 14 warnings. Go `test ./...` and `vet ./...` passed; the Linux race
run passed 102 top-level tests with zero race reports. The build, dev/built
desktop/mobile rendering and actual native runtime integration are recorded in
[`baseline.md`](baseline.md). The concrete A/B evaluation adapter also passed
against isolated PostgreSQL, Eino workers and the built app, with three fake
model sends and zero paid calls. No human blind quality assessment or real
supplier A/B/C experiment has been performed.
