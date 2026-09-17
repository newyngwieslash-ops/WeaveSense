# Go Standards third review — 2026-09-08

Scope: current working tree, read-only business review. New artifacts only under this directory; no old evidence or production code changed. Parent owns the formal full suite. All probe model traffic uses localhost fake HTTP/SSE services with synthetic credentials.

## Observations in previous Go review order

1. **C4 fixed-call/output boundary: repaired; repair contract still incomplete (P2, static).** `workflow.go:67,78` now passes the actual policy output limit and `generateOnce` no longer uses the old hardcoded 1800. Zero remaining calls are no longer replaced with one. Do not repeat the previous fixed-budget finding. However, `workflow.go:74-76` still supplies only a parse error, without original malformed output or a concrete target schema; research adds an 800-rune original at `research.go:96-98` but still says “the research schema” without providing it. C4.6 asks for concrete mode schema, bounded original output, validator errors and evidence constraints. This is code not implemented, not merely real-provider verification pending.

2. **C4.3/C6.4 Skill positive-budget exhaustion: P1, reproduced.** `research.go:34-40` disables skills when initial MaxToolCalls is zero; it does not guard each actual invocation. The unchanged middleware insertion in `skills.go` still bypasses `takeTool`. Probe uses budget 1 and requests the same Skill twice, then a final answer. Result: two Skill results, three actual model requests, success, and ToolCalls=0. Thus the formal zero-budget regression passes by hiding the tool for one input value, while the requested shared execution budget is still absent. Available Skill hashes are also still reported as if they were usage rather than recording actual used versions.

3. **C4.4/C4.5 Stream completion and usage: P2, reproduced/static.** `model.go:57-61` now emits an event when Stream opens. It immediately marks OK based on opening, returns the raw reader and never observes subsequent Recv failures, cancellation, close or final usage. Malformed later SSE reproduces Recv error with an OK=true event. `research.go:119-123` omits accumulated input/output token usage: fake vendor returns known usage for each of three model calls, but Runtime has nil/nil. `workflow.go:94-102` still records only the last response after repair. Current research keeps streaming disabled, so late-stream audit is a supported-wrapper limitation, not the current research execution path. Existing wire output and Stream call-count limits are not alleged broken.

4. **C5.1/C5.2 MCP redirect credential boundary: repaired.** `mcp.go:68` now passes the real MCP transport an HTTP client with 8-second timeout and redirect rejection. The previous token-forwarding defect is not carried forward. Real external MCP compatibility remains a separate validation task; code-level redirect repair is present.

5. **C5.2–C5.5 MCP receipt/lifecycle: P1, static, code missing.** `mcp.go:157-162` still generates a process-global sequence ID, adds evidence to a Go memory bag and returns it to the model. There is no authenticated receipt persistence call, run-bound sequence or model-independent persisted URL/source metadata. Current `agent-data.ts` only exposes internal search/get_item/get_analysis actions; no MCP receipt action exists. Final TS citation validation reads persisted receipts, so a new external citation cannot complete its required persistence chain. Client Close ownership is still absent; 4000-rune truncation still occurs after decoding, without predecode byte/block bounds. This is not merely an unconfigured real MCP service.

6. **C6 Skills filesystem boundary: main escape/bounded-read corrections are present.** `skills.go` now resolves root and target symlinks, checks actual ancestry in both Read and GlobInfo, uses MAX+1 bounded reading and propagates Walk rejection errors. Do not repeat the old ancestor escape. Initial sandbox test failure was `EvalSymlinks` Access denied on `C:\Users\ADMINI~1\...`; rerunning the identical positive-budget probe outside the sandbox resolved the long pathname correctly and loaded the skill. No TEMP/TMP relocation or permission workaround was used. The parent owns final formal-suite verdict. Used-versus-available metadata and per-load budget remain C4/C6 incomplete per item 2.

7. **C8 checkpoint/Resume: P1, static, code missing.** `research.go:64-66` still constructs `httpStore` without claimToken and calls Query without a checkpoint ID. Current project has no actual Resume/WithCheckPointID/interrupt/lease-renew integration or restored budget state. Adding CheckPointStore alone does not trigger Eino checkpoint persistence. `httpStore.Get` now correctly returns an error for HTTP409, so that previous defect is repaired; it does not establish restart recovery. C8.2–C8.6 require the missing implementation plus process kill/restart evidence.

8. **C3 Worker ACK: HTTP error return repaired; reliable completion still incomplete (P1, static).** `worker.go:165-170` now returns postJobs failure/status rejection. The real loop at `worker.go:113` still discards RunWorkerOnce errors. No response retention, bounded idempotent complete retransmission or recorded unacknowledged-completion state exists. A transient completion response loss discards the computed answer from worker memory and proceeds to another claim. C3.2 explicitly requires retaining and resending the same result without rerunning the model. This missing closure must not be described as only a production test remaining.

## New probes and outcomes

```text
go -C workers/agent test -overlay ../../validation/agent/review-third-2026-09-08/go-overlay.json ./internal/agent -run TestThirdPositiveSkillBudget -v -count=1
```

First sandbox attempt could not resolve the permitted temp path and reached zero model calls. The probe was strengthened to explicitly fail if initialization prevents model execution; an earlier zero-call observation is not evidence that a positive Skill budget works. Identical command rerun with required escalation produced:

```text
resolved="C:\Users\Administrator\AppData\Local\Temp\TestThirdPositiveSkillBudget655923100\001"
rel="." errors=<nil>/<nil>/<nil> inRoot=true
policy_tool_calls=1 received_skill_results=2 model_calls=3
Runtime: InputTokens=nil OutputTokens=nil ModelCalls=3 ToolCalls=0
ok=true err=nil
FAIL: positive skill budget bypassed after exhaustion
FAIL: executed skills not counted
FAIL: known vendor usage discarded
```

```text
go -C workers/agent test -overlay ../../validation/agent/review-third-2026-09-08/go-overlay.json ./internal/agent -run TestThirdStreamLateErrorAudit -v -count=1
```

The Stream probe ran as part of the initial `-run TestThird` command and failed for the intended reason:

```text
recv_error=failed to receive stream chunk: invalid character 'i' looking for beginning of object key string
audit_events=[{Type:model Name:fake DurationMS:1 OK:true}]
FAIL: stream parse failure audited as successful
```

## C11 old-overlay reproducibility conflict — P2, reproduced

The formal `followup_regression_test.go` copies all seven TestFollowup function names from the preserved old overlay. The old overlay still inserts a separate source file into the same package, so the documented old command now fails before executing any checks:

```text
go -C workers/agent test -overlay ../../validation/agent/review-followup-2026-09-08/go-overlay.json ./internal/agent -run '^$' -count=1
```

Sandbox attempt was stopped by cache Access denied. Identical compile-only command rerun with escalation gives seven redeclarations: TestFollowupFixedOutputAndZeroBudget, TestFollowupSkillBudget, TestFollowupCheckpointHTTPError, TestFollowupAncestorSymlink, TestFollowupMCPRedirect, TestFollowupWorkerAcknowledgement, TestFollowupStreamWire. It exits 1. Formal declarations are at lines 18,34,50,58,65,78,89 respectively. The normal suite does not use this overlay and is not claimed broken by redeclarations. Update reproducibility instructions or use a new overlay that replaces the formal file; preserve old historical evidence rather than editing it retroactively.

## Scope of conclusions

No real model or external MCP requests, no business DB changes, no full-suite duplication. Status is based on current source and the explicitly listed probes. Missing persistence/resume/ACK code is distinguished from unavailable production credentials or platform-specific validation. Unused `countedModel` remains a minor possible Speculative Generality smell and is not promoted over functional defects.
