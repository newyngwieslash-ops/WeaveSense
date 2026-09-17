# Go Standards follow-up review — 2026-09-08

Scope: current uncommitted working tree relative to `76b6da1`, Go execution/model/tools/MCP/Skills/worker/checkpoint. No business source changes. All probe network traffic uses local `httptest` servers and synthetic credentials. Original evidence remains unchanged.

## Verified improvements

- Research now uses a `budgetModel`; actual model calls are deducted and research output settings are transmitted.
- The direct Stream wrapper sends configured `max_tokens`, consumes the call budget and denies a second request with budget 1.
- Research no longer includes the contradictory “Do not call tools” instruction.
- Internal parallel tool event appends now use the budget mutex. Do not carry over the old no-lock tool finding.
- MCP TokenEnv is read and sent; per-call IDs are generated and returned to the model.
- Direct skills-root escapes and a symlink at the final file component are checked. The remaining finding is ancestor symlinks, not the old unrestricted absolute-path claim.
- Worker entry and HTTP entry now share Server.RunBounded concurrency/deadline control.

## Reproduction commands

```text
go -C workers/agent test -overlay ../../validation/agent/review-followup-2026-09-08/go-overlay.json ./internal/agent -run TestFollowup -v -count=1
```

Actual execution was split into first five functions, then the two additional Worker/Stream functions. Both commands exited 1 because the defect assertions failed. Seven test functions, eight subcase observations; no real model/MCP was called.

```text
TestFollowupFixedOutputAndZeroBudget/1:
calls=1 output_on_wire=1800 requested_output=12 response_ok=true error=<nil>
TestFollowupFixedOutputAndZeroBudget/0:
calls=1 output_on_wire=1800 requested_output=12 response_ok=true error=<nil>
TestFollowupSkillBudget:
tool_result_received=true ModelCalls=2 ToolCalls=0 InputTokens=nil OutputTokens=nil response_ok=true
TestFollowupCheckpointHTTPError:
found=false error=<nil>  [server returned HTTP409/version_mismatch]
TestFollowupAncestorSymlink:
read outside through ancestor symlink: OUTSIDE
TestFollowupMCPRedirect:
cross_origin_auth_forwarded=true  [HTTP307 to different local port, synthetic token only]
TestFollowupWorkerAcknowledgement:
complete HTTP500 worker_error=<nil>
TestFollowupStreamWire:
stream wire_calls=1 max_output=12 remaining=0 second_error=budget_exceeded audit_events=0
```

## Findings in Standards order

1. **P1, reproduced — fixed workflow policy bypass.** `model.go:104` hardcodes 1800 for `generateOnce`, which services fixed workflows and repair, despite the request policy. `workflow.go:40-41` changes zero model-call allowance to one. Direct Execute returns success after the forbidden call; HTTP may later reject negative reported runtime, but the provider request already happened. Remediation Task 6 requires all Generate/Stream/repair calls to share the policy and zero budget to mean zero calls; original plan §5.1 requires local maxima.

2. **P1, reproduced — skill-tool budget bypass.** `skills.go:159` supplies the standard middleware directly; its tool never passes guardedTool/takeTool. Research with MaxToolCalls=0 actually loads the skill and reports ToolCalls=0. Remediation Task 6 and Task 13 Step 4 explicitly count loading and context usage. This is separate from the successfully fixed research model-call counter.

3. **P2, reproduced/static — incomplete usage and Stream auditing.** `model.go:52-57` returns the raw stream without event/usage completion tracking; reproduced successful Stream emits zero events. `research.go:114-118` omits input/output usage even when fake vendor returned it. Fixed flow `workflow.go:94-102` records only the last response rather than aggregating repair usage. Remediation Tasks 6/7 require accumulated actual known usage and bounded auditable events. Stream is disabled in current research runner, so the stream audit defect is currently a wrapper-path limitation, not the current research execution path.

4. **P1, reproduced — MCP credential forwarding on redirect.** `mcp.go:72-75` now sends the token but uses a default HTTP redirect policy. A 307 from one local port to another forwards the synthetic Authorization header. Remediation Task 12 Step 2 explicitly forbids cross-origin redirects; set the actual client transport policy before enabling credentials. Existing direct internal Data API correctly denies redirects and can guide reuse.

5. **P1, static — MCP evidence is not a persisted receipt.** `mcp.go:154-159` adds evidence only to a Go memory bag and returns it to the model. There is no authenticated internal evidence write; `agent-data.ts` only writes internal retrieval receipts. TS final validation (`analyze.ts:449-451`, `agent-jobs.ts` complete) reads persisted receipts, so an otherwise valid external citation cannot be saved. The sequence is global process-local, not run-bound, and resets after restart. Remediation Task 12 Step 4 requires run-bound, persisted receipts before tool output. Also absent: owned Close lifecycle, per-tool 8-second deadline, predecode byte/content-block bounds; posthoc 4000-rune truncation is insufficient.

6. **P1, reproduced — ancestor symlink escapes Skills root.** `skills.go:40-52` validates lexical ancestry and only Lstat's the final component; a root/ref symlink to an outside directory allows root/ref/data.txt to be read. The probe succeeded without skips on this host. `GlobInfo:64` does not validate requested root; `skillVersions:100` still discards traversal rejection errors, and ReadFile happens before size rejection. Remediation Task 13 Steps 1–3 require nested-symlink/junction/actual-path checks and bounded reads. This proves a filesystem backend boundary defect; it does not claim the present name-based Skill tool accepts arbitrary user-selected paths.

7. **P1, static + reproduced — checkpoint is wired only nominally.** `research.go:59-61` constructs a store with no claimToken and starts Query without WithCheckPointID; project code contains no Resume, interrupt checkpoint ID, renewal, or remaining-budget restore call. Eino only writes checkpoint at checkpoint-enabled interrupt/cancel points. `worker.go:37` additionally turns HTTP409 into `(nil,false,nil)` (reproduced), swallowing version mismatch. Remediation Task 10 requires actual safe interruption/resume and propagation of conflict errors. Merely setting CheckPointStore does not provide restart recovery.

8. **P1, reproduced — worker discards complete rejection.** `worker.go:162-163` drops the HTTP status/error and returns execution error only. A completed fake run whose result persistence receives HTTP500 returns nil, losing visible failure/acknowledgement and leaving the job unresolved. Remediation Task 8/10 require complete retry/idempotent acknowledgement and observable persistence failures. The polling loop also discards RunWorkerOnce errors; do not automatically rerun the paid model to compensate.

## Additional lower-priority observations

- Fixed JSON repair (`workflow.go:74-76`) still supplies neither original malformed output nor concrete target schema. Research now adds a truncated original, but no concrete repair schema. This partially addresses the old finding rather than closing remediation Task 6.
- `countedModel` is still unused; `if cfg.MaxConcurrent > 0 { maxOut = 1800 }` repeats the same assignment. These are optional Speculative Generality/duplicated-code judgments, not substitutes for functional findings.
- No fresh race claim is made. The main agent owns the full suite and original overlay checks, so they were not duplicated here.
