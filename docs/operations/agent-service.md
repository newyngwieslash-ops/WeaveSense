# Agent service operations

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

## Host test notes

- `go test ./internal/agent -run TestHTTP` PASS on Windows with `CGO_ENABLED=0`.
- `go test -race` is not available on this host: `go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`. Re-run race tests in the Linux Docker/QA image.

## Deploy

Compose service `agent` has **no host ports**. App talks to `http://agent:8791`. Agent talks back to `http://app:8080/api/internal/agent-data` for research tools. There is no bidirectional health dependency: the app starts and shows collected items if the agent is down. Eino operations then return `agent_unavailable` and do not fall back to legacy.

Vercel deploys only the TypeScript app. The Go agent must run as a separate internal service. Do not spawn Go from ServerFn.

Default `AI_ENGINE=legacy`. Set `eino` only after `AGENT_SERVICE_TOKEN` and `AGENT_DATA_TOKEN` are independent random secrets. MCP example config is disabled. Empty `allowed_tools` exposes no tools. Skills are the three packaged files under `workers/agent/skills`; versions are SHA-256 of allowed files.

Rollback: set `AI_ENGINE=legacy` for new tasks. Keep `ai_runs` and existing analyses/notes. Do not down-migrate. Stop the Go service only after in-flight runs expire.

## MCP / Skills coverage

Verified offline: Streamable HTTP tools + allowlist + empty allowlist = 0 tools. Not claimed: MCP Resources, Prompts, OAuth, or a real remote MCP server.

## Unverified

- Real xAI / OpenAI-compatible tool calling, JSON mode, and usage
- Any production MCP server
- `go test -race` on this Windows host (needs cgo)
- Docker image build in this session
- Desktop/mobile browser smoke against `/workspace` (Linux QA path; this host is Windows)
- Any production MCP server
- Docker image build and Compose agent wiring (Task 15)
- PGlite vs PostgreSQL atomic-save race (Task 16)
