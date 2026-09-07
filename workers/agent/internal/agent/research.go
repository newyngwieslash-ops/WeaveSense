package agent

import (
	"context"
	"strings"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

func runResearch(ctx context.Context, cfg Config, req ExecuteRequest, coverage Coverage) (ExecuteResponse, error) {
	budget := &runBudget{modelLeft: req.Policy.MaxModelCalls, toolLeft: req.Policy.MaxToolCalls}
	if budget.modelLeft <= 0 {
		budget.modelLeft = 1
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
	skillHandler, skillVersions, skillErr := loadSkillHandler(ctx, cfg)
	if skillErr != nil {
		return fail(req.RunID, "invalid_request", false, false), nil
	}

	cm, err := newChatModel(cfg, remainingDeadline(ctx))
	if err != nil {
		return fail(req.RunID, "agent_unconfigured", false, false), nil
	}
	handlers := []adk.ChatModelAgentMiddleware{}
	if skillHandler != nil {
		handlers = append(handlers, skillHandler)
	}
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:          "research",
		Description:   "corpus research",
		Instruction:   systemPrompt(ModeResearch, coverage) + "\nUse search_items and get_item. Never invent evidence_id.",
		Model:         cm,
		MaxIterations: 6,
		ToolsConfig:   adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{Tools: tools}},
		Handlers:      handlers,
		ModelRetryConfig: nil,
	})
	if err != nil {
		return fail(req.RunID, "agent_unavailable", true, false), nil
	}
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent})
	iter := runner.Query(ctx, userPrompt(req))
	var last string
	for {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			if strings.Contains(event.Err.Error(), "budget") {
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
	if parseErr != nil && budget.takeModel() {
		repair, err := generateOnce(ctx, cfg, &budget.modelLeft, &events, []*schema.Message{
			schema.SystemMessage("Return only JSON."),
			schema.UserMessage("invalid_output: " + parseErr.Error()),
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
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         req.RunID,
		OK:            true,
		Result:        result,
		Runtime: &Runtime{
			Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: skillVersions,
			ModelCalls: req.Policy.MaxModelCalls - budget.modelLeft, ToolCalls: req.Policy.MaxToolCalls - budget.toolLeft,
			Events: events,
		},
		Evidence: append(sourcesToEvidence(req.Input.Sources), bag.all()...),
	}, nil
}

