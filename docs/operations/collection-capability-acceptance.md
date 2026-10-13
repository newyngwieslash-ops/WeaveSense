# Collection capability acceptance

Recorded 2026-10-13 in the isolated `codex/collection-capability` worktree.

```json
{
  "scope": "collection-capability",
  "baseline": "bec6212ac0cdc67272e488073e35d97087e7447a",
  "checkout": "fb9b96273bb568f3d951f4a20142c36a677ae52f",
  "checks": [
    {"id":"A01-rss-cursor-scheduler","status":"passed","exit_code":0,"tests":18},
    {"id":"A01-keyword-pagination","status":"passed","exit_code":0,"tests":20},
    {"id":"A01-wechat-gateway","status":"passed","exit_code":0,"tests":59},
    {"id":"A02-rss-normalization","status":"not_run"},
    {"id":"A03-primary-normalization","status":"not_run"},
    {"id":"A04-keyword-identity","status":"not_run"},
    {"id":"A05-coverage-persistence","status":"not_run"}
  ],
  "live_status": "not_run",
  "release_status": "not_deployed"
}
```

## Baseline and environment

- Baseline application SHA: `bec6212ac0cdc67272e488073e35d97087e7447a`. Checkout SHA: `fb9b96273bb568f3d951f4a20142c36a677ae52f`; the difference is the approved roadmap document only.
- Initial isolated worktree `git status --short`: empty. Existing original-workspace changes reported by the task constraints: modified `src/routeTree.gen.ts`; untracked `docker-compose.dev-hybrid.yml` and `docker-compose.override.yml`. They were not copied or changed.
- Node: `v24.16.0`. Lockfiles: `package-lock.json` only. Highest migration: `0029_assistant_progress.sql`; `0030_collection_coverage.sql` was absent at baseline.
- Locked dependency installation: `npm ci --ignore-scripts --no-audit --no-fund`, exit 0; 428 packages installed locally. No dependency declaration or lockfile changed, no junction needed. Both original and worktree lock SHA256: `ADDDD028C346B3B43AAFB3A0DE809F0A917FEE05D58BE3563EFACAF2E95A756B`.

## Runnable A01 checks

Execute each command through the existing `offlineEnv` helper, as shown below. `DATABASE_URL` is removed; all automatic analysis and workers are explicitly disabled, and `LOOM_MODEL_CONFIG` is a nonexistent absolute path. No live database, model configuration, provider credentials, or production service is used. Test-local HTTP fixtures and ephemeral PGlite/SQLite databases are allowed.

```js
import { spawnSync } from "node:child_process";
import { offlineEnv } from "./scripts/readiness-offline.mjs";
const env = offlineEnv(process.env, {
  AUTO_ANALYZE: "false", EXTRACT_AUTO: "false",
  AGENT_WORKER_ENABLED: "false", AGENT_ASYNC_RESEARCH_ENABLED: "false",
  AGENT_OPENCODE_WORKER_ENABLED: "false", AGENT_ASSISTANT_ENABLED: "false",
  AGENT_ASSISTANT_ACTIONS_ENABLED: "false", DATABASE_URL: undefined,
  XAI_API_KEY: "", LOOM_MODEL_CONFIG: "C:/collection-offline-no-model-config.json",
});
const groups = [
  ["--experimental-strip-types", "--test", "src/lib/server/rss.test.ts", "src/lib/server/cursor.test.ts", "src/lib/server/scheduler-atomic.test.ts"],
  ["--test", "src/lib/server/collectors/keyword-contract.test.mjs", "src/lib/server/collectors/pagination.test.mjs"],
  ["--test", "workers/wechat-gateway/gateway.test.mjs"],
];
for (const args of groups) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

| Exact child command | Exit | Result |
| --- | --- | --- |
| `node --experimental-strip-types --test src/lib/server/rss.test.ts src/lib/server/cursor.test.ts src/lib/server/scheduler-atomic.test.ts` | 0 | 18 passed, 0 failed/skipped; 12.99 s |
| `node --test src/lib/server/collectors/keyword-contract.test.mjs src/lib/server/collectors/pagination.test.mjs` | 0 | 20 passed, 0 failed/skipped; 49.03 s |
| `node --test workers/wechat-gateway/gateway.test.mjs` | 0 | 59 passed, 0 failed/skipped; 1.58 s |

## Existing implementations and boundaries

All named implementation symbols are present; reuse them for A02-A05.

- `parseFeedXml` in `src/lib/server/rss-parser.ts`: existing RSS/Atom parser, body-size and metadata checks.
- `fetchPrimary` in `workers/wechat-gateway/primary.mjs`: Atom/RSS/RDF reader with entry validation; examines `entries.slice(0, 24)`, skips invalid siblings, and returns an item array.
- `collectKeyword` in `src/lib/server/collectors/keyword.ts`: scoped provider attempts, URL/external-id de-duplication, and a merged result cap of 40. YouTube currently uses Google News `site:youtube.com` search; it is not proof of exhaustive YouTube search.
- `CollectorCoverage` in `src/lib/server/collectors/types.ts`: `complete`, optional `window_only`, optional `note`.
- `runSourceJob` / local `cursorSafe` in `src/lib/server/scheduler.ts`: missing coverage currently counts as safe; explicit incomplete coverage blocks cursor advancement but the successful job still finishes with status `ok`.
- `finishSourceJob` / `mergeExistingItem` in `src/lib/server/scheduler-atomic.ts`: existing atomic persistence helpers. Source job finalization currently stores counts and provider metadata, without coverage fields.
- `JobRow` / `mapJob` in `src/lib/types.ts` / `src/lib/server/queries.ts` and `/jobs` in `src/routes/jobs.tsx`: existing reporting path; baseline job type and mapper contain no coverage fields.
- `scripts/collection-load-check.mjs`: existing deterministic real-scheduler/PostgreSQL load harness, with isolated Docker PostgreSQL and synthetic outbound responses; accepts 1-5000 sources. It was inspected only and was not run in A01. Its existence does not establish live provider reliability.

## Remaining acceptance boundary

A01 establishes an offline baseline only. A02-A05 checks must be updated to actual results after implementation; sustained uptime, live success rates, account/subtitle/licence/paid-quota samples, load runs, browser QA, and release checks remain unverified. No production deployment was performed. Dependency installation emitted existing deprecated-package warnings for recharts and eslint; no upgrade was made.
