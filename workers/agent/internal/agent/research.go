package agent

import (
	"context"
	"errors"
	"strings"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

func runResearch(ctx context.Context, cfg Config, req ExecuteRequest, coverage Coverage) (response ExecuteResponse, executionErr error) {
	ctx, closeResources := context.WithCancel(ctx)
	defer closeResources()
	budget := &runBudget{modelLeft: req.Policy.MaxModelCalls, toolLeft: req.Policy.MaxToolCalls}
	if budget.modelLeft < 0 {
		budget.modelLeft = 0
	}
	if budget.toolLeft < 0 {
		budget.toolLeft = 0
	}
	events := make([]RuntimeEvent, 0, 16)
	bag := &evidenceBag{}
	ctx = withBudget(ctx, budget)
	ctx = withRunToken(ctx, req.DataAccessToken)
	ctx = context.WithValue(ctx, ctxEvidence, bag)

	tools := internalTools(cfg, req.RunID, &events)
	mcpTools, mcpWarn, err := loadMCPTools(ctx, cfg, &events, bag)
	if err != nil {
		return fail(req.RunID, "tool_unavailable", false, false), nil
	}
	tools = append(tools, mcpTools...)
	var skillHandler adk.ChatModelAgentMiddleware
	skillVersions := map[string]string{}
	defer func() {
		if !response.OK {
			i, o := budget.usage()
			response.Runtime = &Runtime{Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: skillVersions,
				InputTokens: i, OutputTokens: o, ModelCalls: req.Policy.MaxModelCalls - budget.modelLeft, ToolCalls: req.Policy.MaxToolCalls - budget.toolLeft, Events: events}
		}
	}()
	if req.Policy.MaxToolCalls > 0 {
		var skillErr error
		skillHandler, skillVersions, skillErr = loadSkillHandler(ctx, cfg)
		if skillErr != nil {
			return fail(req.RunID, "invalid_request", false, false), nil
		}
		if cfg.SkillsDir != "" {
			tools = append(tools, skillResourceTool(cfg, skillVersions, &events))
		}
	}

	inner, err := newChatModel(cfg, remainingModelDeadline(ctx, cfg), req.Policy.MaxOutputTokensPerCall)
	if err != nil {
		return fail(req.RunID, "agent_unconfigured", false, false), nil
	}
	claim, durable := ctx.Value(workerContextKey{}).(jobClaim)
	maxIterations := 6
	if durable {
		// Eino v0.9.19 counts both generation and replay after StatefulInterrupt.
		// Keep six logical rounds; runBudget still bounds actual model/tool calls.
		maxIterations *= 2
	}
	cm := &budgetModel{inner: inner, budget: budget, events: &events, name: cfg.ModelName, checkpoint: durable}
	handlers := []adk.ChatModelAgentMiddleware{}
	if skillHandler != nil {
		handlers = append(handlers, skillHandler)
	}
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:             "research",
		Description:      "corpus research",
		Instruction:      researchPrompt(coverage),
		Model:            cm,
		MaxIterations:    maxIterations,
		ToolsConfig:      adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{Tools: tools}},
		Handlers:         handlers,
		ModelRetryConfig: nil,
	})
	if err != nil {
		return fail(req.RunID, "agent_unavailable", true, false), nil
	}
	store := &httpStore{cfg: cfg, runID: req.RunID, claimToken: claim.ClaimToken, seq: claim.Sequence,
		budget: budget, request: &req, events: &events, bag: bag, skills: skillVersions}
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent, CheckPointStore: store, EnableStreaming: false})
	checkpointID := "research:" + req.RunID
	var iter *adk.AsyncIterator[*adk.AgentEvent]
	if durable && claim.Resume {
		iter, err = runner.Resume(ctx, checkpointID)
		if err != nil {
			return fail(req.RunID, "checkpoint_unavailable", false, false), nil
		}
	} else if durable {
		iter = runner.Query(ctx, userPrompt(req), adk.WithCheckPointID(checkpointID))
	} else {
		iter = runner.Query(ctx, userPrompt(req))
	}
	var last string
	interrupted := false
	for {
		event, ok := iter.Next()
		if !ok {
			if interrupted {
				iter, err = runner.Resume(ctx, checkpointID)
				if err != nil {
					return fail(req.RunID, "checkpoint_unavailable", false, false), nil
				}
				interrupted = false
				continue
			}
			break
		}
		if event.Action != nil && event.Action.Interrupted != nil {
			interrupted = true
		}
		if event.Err != nil {
			if errors.Is(event.Err, adk.ErrExceedMaxIterations) || strings.Contains(event.Err.Error(), "budget") {
				return fail(req.RunID, "budget_exceeded", false, false), nil
			}
			code, retryable, unknown := classifyModelError(event.Err)
			return fail(req.RunID, code, retryable, unknown), nil
		}
		if event.Output != nil && event.Output.MessageOutput != nil {
			msg, err := event.Output.MessageOutput.GetMessage()
			if err == nil && msg != nil && msg.Role == schema.Assistant && msg.Content != "" && len(msg.ToolCalls) == 0 {
				last = msg.Content
			}
		}
	}
	if last == "" {
		return fail(req.RunID, "invalid_output", false, false), nil
	}
	result, parseErr := parseModelJSON(last, ModeResearch, coverage)
	if parseErr != nil {
		bounded := last
		if len([]rune(bounded)) > 800 {
			bounded = string([]rune(bounded)[:800])
		}
		repair, err := generateOnce(ctx, cfg, &budget.modelLeft, req.Policy.MaxOutputTokensPerCall, &events, []*schema.Message{
			schema.SystemMessage(researchPrompt(coverage) + " Keep evidence_id and quotes exact. Never fabricate evidence."),
			schema.UserMessage("invalid_output: " + parseErr.Error() + "\nOriginal:\n" + bounded),
		})
		if err == nil {
			result, parseErr = parseModelJSON(repair.Content, ModeResearch, coverage)
		}
	}
	if parseErr != nil {
		return fail(req.RunID, "invalid_output", false, false), nil
	}
	result.Coverage = coverage
	if len(mcpWarn) > 0 {
		result.Warnings = append(result.Warnings, mcpWarn...)
	}
	if err := ValidateResult(*result, ModeResearch); err != nil {
		return fail(req.RunID, "invalid_output", false, false), nil
	}
	inTok, outTok := budget.usage()
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         req.RunID,
		OK:            true,
		Result:        result,
		Runtime: &Runtime{
			Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: skillVersions,
			InputTokens: inTok, OutputTokens: outTok,
			ModelCalls: req.Policy.MaxModelCalls - budget.modelLeft, ToolCalls: req.Policy.MaxToolCalls - budget.toolLeft,
			Events: events,
		},
		Evidence: append(sourcesToEvidence(req.Input.Sources), bag.all()...),
	}, nil
}
