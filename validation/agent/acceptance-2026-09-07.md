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
| `node --experimental-strip-types --test src/lib/server/agent-queue.test.ts` | PASS |
| `node --experimental-strip-types --test src/lib/server/agent-checkpoints.test.ts` | PASS |
| `node scripts/agent-contract-check.mjs` | PASS (`agent-contract-check: ok`) |
| `node scripts/agent-e2e.mjs` | PASS (`agent-e2e: PASS`) |
| `node --experimental-strip-types scripts/agent-retrieval-eval.mjs` | PASS (recall@8 0.5172 → 0.9655, none-cases empty) |
| `npm test` | PASS (156 tests) |
| `GOTOOLCHAIN=local CGO_ENABLED=0 go -C workers/agent test ./... -count=1` | PASS |
| `GOTOOLCHAIN=local CGO_ENABLED=0 go -C workers/agent vet ./...` | PASS |
| `go test -race` | **not run** — host: `go: -race requires cgo` |
| `npx tsc --noEmit` | PASS |
| `node scripts/with-app-env.mjs node ./node_modules/vite/bin/vite.js build` | PASS (`npm run build` / `npx vite` hit `spawn npx ENOENT` on this host; Vite invoked through the wrapper) |
| `WECHAT_GATEWAY_TOKEN=x CRON_SECRET=x WECHAT_PRIMARY_ALLOWED_HOSTS=example.com docker compose config --quiet` | PASS |
| `docker compose build agent` | PASS (`gig5cyrba5yn3tsi-grok-workspace-agent` Built) |
| `node scripts/browser-smoke.mjs` against `/workspace` | **not run** — Linux QA path; this host is Windows |

## Engine / database

- PGlite: Task 3/8/10/18/19 semantic tests PASS.
- PostgreSQL multi-connection races: **not run** on this host (`DATABASE_URL` unset, no `psql`).
- Engines: default remains `legacy`. Eino covered by fake execute / httptest protocol servers.
- Real xAI: **not run**. `XAI_API_KEY` unset; this plan is not paid-test authorization.

## Version matrix

See `docs/operations/agent-service.md`. Direct Go modules: Eino v0.9.19, OpenAI adapter v0.1.13, MCP adapter v0.0.9, mark3labs/mcp-go v0.43.0.

## Screenshots

Not captured in this Windows session. Linux QA should write `screenshots/agent-dev.png` and `screenshots/agent-built.png`.

## Unverified

- Real model vendor tool calling / JSON mode / usage
- Real MCP server (example config remains `enabled: false`)
- `go test -race` (needs cgo; this Windows MinGW cannot compile 64-bit)
- PostgreSQL multi-connection races
- Desktop/mobile browser smoke against `/workspace`
- Production enablement (`AI_ENGINE=eino` in a live deploy)
- `AUTO_ANALYZE=true` daily-budget live run

## Rollback (documented, not exercised against a paid model)

1. Set `AI_ENGINE=legacy` for new tasks.
2. Keep `ai_runs`, analyses, notes, `ai_jobs`, and checkpoints. Do not down-migrate.
3. Stop the Go service only after in-flight runs expire.
4. Failed Eino requests do not implicitly call legacy.

## Delivery status

| Slice | Status |
| --- | --- |
| Code for P1/P2 + deploy wiring | implemented |
| Offline protocol / PGlite tests | verified |
| P3 auto-analyze queue | implemented, default off |
| P3 long research jobs | implemented; worker claims research jobs only |
| P3 retrieval keyword split/weighting | implemented; no vector DB |
| Real model / real MCP | **not verified** |
| Production enable | **not enabled** (default `legacy`) |
