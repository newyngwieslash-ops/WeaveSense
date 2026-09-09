# Agent service operations

Current implementation and release status: [V3 acceptance](../../validation/agent/implementation-v3-2026-09-08/acceptance.md). Historical baseline sections below are explicitly dated; real supplier and production verification remain pending authorization.

Internal Eino analysis worker for Loom. The TypeScript app owns materials, authorization, idempotency and persistence. This Go service only executes models and tools.

## Toolchain recorded 2026-09-07

| Tool | Version |
| --- | --- |
| Node | v24.13.0 (project still targets Node 22 for the app) |
| Go | go1.24.1 windows/amd64 |
| Git | worktree is project root; metadata is `.repo` |
| Branch | `feature/eino-agent` |
| Host | Windows 10; Linux QA path remains `/workspace` |

`git --git-dir=.repo --work-tree=. status --short` at Task 1 start showed a pre-existing `restart.bat` modification. That file is not part of this work and is left unchanged.

Compose remains the production-shaped local stack: `app`, `postgres`, `minio`, `telethon`, `wechat-gateway`, `scheduler`. The agent service is added later as an internal container with no host port.

## Locked dependency matrix

Selected from published tags on 2026-09-07. No `@latest` install scripts.

| Component | Module | Tag | Go requirement |
| --- | --- | --- | --- |
| Eino | `github.com/cloudwego/eino` | v0.9.19 | go 1.18 |
| OpenAI protocol adapter | `github.com/cloudwego/eino-ext/components/model/openai` | v0.1.13 | go 1.18 |
| MCP tool adapter | `github.com/cloudwego/eino-ext/components/tool/mcp` | v0.0.9 | go 1.23.0 |
| MCP client | `github.com/mark3labs/mcp-go` | v0.43.0 (required by MCP adapter) | go 1.23 |
| Skill filesystem backend | `github.com/cloudwego/eino/adk/middlewares/skill` + `adk/filesystem` | ships with Eino v0.9.19 | go 1.18 |
| Skill middleware | `github.com/cloudwego/eino/adk/middlewares/skill` | ships with Eino v0.9.19 | — |
| Model name / API address | configured at runtime | `AGENT_MODEL_NAME` / `AGENT_MODEL_BASE_URL` | keys never stored in this file |

`eino-ext/adk/backend/local@v0.2.5` pulls `go-fitz` and needs CGO; this host’s MinGW cannot compile 64-bit cgo. `v0.2.6` needs Go 1.25. Neither is locked. Skills use Eino’s official `skill.NewBackendFromFilesystem` over a read-only `filesystem.Backend` (in-memory in probes; a tiny os-backed reader in the service). That matches “no generic filesystem or shell for the Agent”.

The official MCP adapter example still shows SSE. Task 1 protocol tests use `client.NewStreamableHttpClient` against `server.NewTestStreamableHTTPServer`. SSE is not treated as the production transport.

## Protocol probe results

Commands:

```sh
go -C workers/agent mod tidy
go -C workers/agent test ./internal/agent -run 'Test(ModelRoundTrip|ToolCallRoundTrip|SkillLoad|MCPTransport)$' -count=1
go -C workers/agent list -m all
```

Recorded 2026-09-07 on Windows with `GOTOOLCHAIN=local CGO_ENABLED=0`:

```
ok  	loom.local/agent/internal/agent	2.690s
```

All four probes passed: `TestModelRoundTrip`, `TestToolCallRoundTrip`, `TestSkillLoad`, `TestMCPTransport`. They only talk to `httptest` fakes and do **not** prove a production model’s tool calling, JSON mode, or usage fields.

Final locked direct modules after `go mod tidy`:

- `github.com/cloudwego/eino v0.9.19`
- `github.com/cloudwego/eino-ext/components/model/openai v0.1.13`
- `github.com/cloudwego/eino-ext/components/tool/mcp v0.0.9`
- `github.com/mark3labs/mcp-go v0.43.0`
- OpenAI ACL helper `github.com/cloudwego/eino-ext/libs/acl/openai v0.1.17` (indirect)

`eino-ext/adk/backend/local` is not a runtime dependency. Skills use Eino’s official filesystem skill backend.

## Runtime contract (filled as later tasks land)

- `POST /v1/execute` is the only execution API. Auth is `AGENT_SERVICE_TOKEN`, not `CRON_SECRET`.
- `GET /healthz` is liveness. `GET /readyz` checks local config and skill loading, never a paid model.
- Default engine is `AI_ENGINE=legacy`. Eino is explicit.
- MCP example config is disabled. Empty `allowed_tools` exposes no tools.
- Skills are versioned by a stable hash of allowed files. Fork/model/agent overrides are rejected.

## Host test notes (historical baseline)

- `go test ./internal/agent -run TestHTTP` PASS on Windows with `CGO_ENABLED=0`.
- `go test -race` is not available on this host: `go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`. Re-run race tests in the Linux Docker/QA image.

## Deploy

Compose service `agent` has **no host ports**. App talks to `http://agent:8791`. Agent talks back to `http://app:8080/api/internal/agent-data` for research tools. There is no bidirectional health dependency: the app starts and shows collected items if the agent is down. Eino operations then return `agent_unavailable` and do not fall back to legacy.

Vercel deploys only the TypeScript app. The Go agent must run as a separate internal service. Do not spawn Go from ServerFn.

Default `AI_ENGINE=legacy`. Set `eino` only after `AGENT_SERVICE_TOKEN` and `AGENT_DATA_TOKEN` are independent random secrets. MCP example config is disabled. Empty `allowed_tools` exposes no tools. Skills are the three packaged files under `workers/agent/skills`; versions are SHA-256 of allowed files.

Rollback: set `AI_ENGINE=legacy` for new tasks. Keep `ai_runs` and existing analyses/notes. Do not down-migrate. Stop the Go service only after in-flight runs expire.

## Auto-analyze (P3, off by default)

`AUTO_ANALYZE=false`. Independent of `EXTRACT_AUTO`. Queue identity is `(item_id, material_hash, policy_version)`. Daily count and RMB worst-cost reserve live in `ai_budget_days`. Empty body, pending OCR, failed media, and an already-valid analysis are skipped. `outcome_unknown` is not auto-retried.

## Long research jobs (P3)

Knowledge questions can enqueue a durable `ai_jobs` row only when effective async capability is available. Go polling additionally requires `AGENT_WORKER_ENABLED=true`; data URL/token alone do not start a worker. Checkpoints contain Eino state, budget, evidence, events and Skill versions. A new claim rotates ownership and data tokens. The worker renews its lease through completion ACK and resumes only a safe saved state; uncertain external calls converge to unknown. The knowledge page polls queued/running jobs every two seconds and keeps the job identity across refreshes.

## Retrieval (historical P3 baseline)

Keyword split + title/late-body weighting is the current search. Vector DB was not introduced. Measured 2026-09-07 labeled set: baseline recall@8 0.5172 → improved 0.9655 (`validation/agent/retrieval-eval-2026-09-07.json`). No-answer cases stayed empty.

## MCP / Skills coverage

Verified offline: Streamable HTTP tools + allowlist + empty allowlist = 0 tools. Not claimed: MCP Resources, Prompts, OAuth, or a real remote MCP server.

## Follow-up remediation 2026-09-08

Offline regressions R01–R09, S01–S08, M01–M02 and the Go follow-up probe pass in the current uncommitted workspace. The Go probe is maintained as `workers/agent/internal/agent/followup_regression_test.go`.

Implemented boundaries: async `complete` rejects missing output, fences job/run/token/lease in one SQL success statement and accepts an identical completed replay; async request identity hashes the question separately from its material hash; zero model/tool allowance sends no fixed-flow or Skill request; fixed output limits reach the model wire; stream attempts are audited; MCP follows no credential-bearing redirect; Skill reads resolve and stay under the configured root; checkpoint stale/version errors surface; known-not-sent failure releases the daily reservation.

The paragraph above records the pre-third-review baseline. V3 now unifies sync/auto/async terminal writes under real transactions, settles from authenticated call facts, persists MCP receipts, implements Eino Resume/lease renewal and includes process-kill, SQL retrieval and browser integration harnesses. Full current evidence and limitations are in V3 acceptance. Default remains `AI_ENGINE=legacy`, `AGENT_ASYNC_RESEARCH_ENABLED=false`, `AGENT_WORKER_ENABLED=false`, and `AUTO_ANALYZE=false`.

## Current offline operations and release gate

`npm run agent:e2e -- --dev` and `npm run agent:e2e` own independent PostgreSQL, fake model/MCP endpoints, current Go and app processes, and browser checks. The built pass uses `npm run preview` on a private port on Windows; it needs no `/proc`. They never target the running production app. `npm run agent:pg` requires `REVIEW_PG_PORT` for a disposable review database. Do not set it to a production port. Formal Go follow-ups are in the normal test package: `go -C workers/agent test ./internal/agent -run 'TestFollowup|TestThird|TestInvariant' -count=1`; do not combine the old duplicate overlay.

Linux CGO race, real PostgreSQL competing transactions, old-data migration rollback/retry, desktop/mobile dev/built interaction and real worker process recovery passed. Commands, screenshots and resource identities are linked in V3 acceptance. These are offline fake-supplier results, not production approval.

Automatic admission requires Eino, `AUTO_ANALYZE=true`, a model name and positive `AGENT_PRICE_INPUT_RMB_PER_MILLION` / `AGENT_PRICE_OUTPUT_RMB_PER_MILLION`. There is no trusted user-entered worst-cost amount: the upper bound follows the enforced two-call request/output limits. Reservations store the model and price version; changing price versions cannot reset the daily allowance. Known usage settles at saved rates; unknown spend retains the reservation. `invalid_output` never establishes zero spend.

Forward migrations 0016–0020 extend the existing ledger and material revision; do not rewrite or down-migrate 0014/0015. Rollback closes new async claims and explicitly cancels queued research jobs, preserves historical results and does not reroute an existing run through another engine. In-flight runs use their saved provider/policy; expiry or unsafe recovery records unknown rather than repeating an uncertain call. Keep the Agent up while permitted in-flight tasks drain; browsing continues if it is unavailable.

Real model tool calling/JSON/usage, real MCP authentication and citations, actual billing, production migrations and deployment/rollback remain unverified and require explicit authorization. Open sync Eino, async worker and automatic analysis separately after their corresponding real checks. No production switches were enabled by this implementation.
