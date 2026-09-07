# Agent acceptance 2026-09-07

Branch: `feature/eino-agent`. Host: Windows 10, Node v24.13.0, Go 1.24.1. Git metadata: `.repo`.

## Commands run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test src/lib/server/agent-contract.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/agent-runs.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/agent-context.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/agent-client.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/analyze.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/agent-data.test.ts` | PASS |
| `node scripts/agent-contract-check.mjs` | PASS (`agent-contract-check: ok`) |
| `node scripts/agent-e2e.mjs` | PASS (`agent-e2e: PASS`) |
| `GOTOOLCHAIN=local CGO_ENABLED=0 go -C workers/agent test ./internal/agent -count=1` | PASS |
| `go test -race` | **not run** — host: `go: -race requires cgo` |
| `npm test` | to be recorded if the full suite is executed |
| `npm run build` / `npm run typecheck` | to be recorded |
| `node scripts/browser-smoke.mjs` against `/workspace` | **not run** — Linux QA path; this host is Windows |

## Engine / database

- PGlite: Task 3/8/10 semantic tests PASS.
- PostgreSQL multi-connection races: **not run** on this host.
- Engines: legacy path remains default; Eino path covered by fake execute / httptest protocol servers.

## Version matrix

See `docs/operations/agent-service.md`. Direct Go modules: Eino v0.9.19, OpenAI adapter v0.1.13, MCP adapter v0.0.9, mark3labs/mcp-go v0.43.0.

## Screenshots

Not captured in this Windows session. Linux QA should write `screenshots/agent-dev.png` and `screenshots/agent-built.png`.

## Unverified

- Real model vendor tool calling / JSON mode / usage
- Real MCP server (example config remains `enabled: false`)
- Docker `compose build agent`
- Production enablement (`AI_ENGINE=eino` in a live deploy)

## Delivery status

| Slice | Status |
| --- | --- |
| Code for P1/P2 + deploy wiring | implemented |
| Offline protocol / PGlite tests | verified |
| Real model / real MCP | **not verified** |
| Production enable | **not enabled** (default `legacy`) |

P3 (auto-analyze, long jobs, retrieval upgrade) was not started; start conditions in the plan are unmet.
