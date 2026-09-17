# Standards review probes — 2026-09-08

Baseline: `d5a67eb95690f7747d4de13c7a1f7f4697444110...76b6da1`.
Read-only business review; added probes live only under `validation/agent/` and use Go overlay. All model traffic goes to `httptest` servers, with synthetic credentials.

Command:

```text
go -C workers/agent test -overlay ../../validation/agent/review-standards-overlay.json ./internal/agent -run TestReviewStandards -v -count=1
```

Observed before adding the separate race probe:

```text
=== RUN   TestReviewStandardsResearchBudget
actual_http_model_calls=2 policy_calls=1 reported_runtime=&{Model:test PromptVersion:loom-agent-v1 SkillVersions:map[] InputTokens:<nil> OutputTokens:<nil> ModelCalls:0 ToolCalls:1 Events:[{Type:tool Name:search_items DurationMS:1 OK:true}]} max_output_transmitted=false result_ok=true err=<nil>
policy max_model_calls bypassed
policy max_output_tokens_per_call not sent
--- FAIL: TestReviewStandardsResearchBudget
=== RUN   TestReviewStandardsSkillRoot
read outside configured skills root: outside sentinel
--- FAIL: TestReviewStandardsSkillRoot
FAIL
```

The skill test demonstrates a missing filesystem backend boundary, not that a model can freely choose arbitrary paths through the current `skill` tool. Eino `Get` resolves discovered names, but a `SKILL.md` symlink can still pass `GlobInfo`'s `os.Stat`; `skillVersions` discards the walk error that was supposed to reject symlinks.

Separate attempted race check:

```text
go -C workers/agent test -race -overlay ../../validation/agent/review-standards-overlay.json ./internal/agent -run TestReviewStandardsEventRace -v -count=1
runtime/race: package testmain: cannot find package
FAIL loom.local/agent/internal/agent [build failed]
```

No race execution claim is made. The shared `events` slice append in `tools.go:134` is not protected, while Eino's tool node may execute parallel tool calls. This finding is based on code inspection.
