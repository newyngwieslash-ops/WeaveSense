package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/schema"
)

const promptVersion = "loom-agent-v1"

type modelJSON struct {
	Summary              string             `json:"summary"`
	Topics               []string           `json:"topics"`
	Entities             []string           `json:"entities"`
	Insights             string             `json:"insights"`
	Tags                 []string           `json:"tags"`
	Title                string             `json:"title"`
	Content              string             `json:"content"`
	Citations            []EvidenceCitation `json:"citations"`
	InsufficientEvidence bool               `json:"insufficient_evidence"`
	Coverage             Coverage           `json:"coverage"`
	Warnings             []string           `json:"warnings"`
}

func Execute(ctx context.Context, cfg Config, req ExecuteRequest) (response ExecuteResponse, executionErr error) {
	ctx = context.WithValue(ctx, executionKey{}, executionReceipt{cfg: cfg, req: req})
	if err := ValidateRequest(req); err != nil {
		return fail(req.RunID, "invalid_request", false, false), nil
	}
	var err error
	ctx, err = withSkillSnapshot(ctx, cfg)
	if err != nil {
		return fail(req.RunID, "skill_unavailable", false, false), nil
	}
	coverage := CoverageFull
	for _, src := range req.Input.Sources {
		if src.Coverage == CoveragePartial {
			coverage = CoveragePartial
		}
	}
	remaining := req.Policy.MaxModelCalls
	if remaining < 0 {
		remaining = 0
	}
	if req.Mode == ModeResearch {
		return runResearch(ctx, cfg, req, coverage)
	}
	events := make([]RuntimeEvent, 0, 8)
	usage := &runBudget{toolLeft: req.Policy.MaxToolCalls}
	ctx = withBudget(ctx, usage)
	skillName := "industry-analysis"
	if req.Mode == ModeBriefing {
		skillName = "briefing-writing"
	}
	loadedSkillVersions := map[string]string{}
	defer func() {
		if !response.OK {
			i, o := usage.usage()
			response.Runtime = &Runtime{Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: loadedSkillVersions,
				InputTokens: i, OutputTokens: o, ModelCalls: req.Policy.MaxModelCalls - remaining, ToolCalls: req.Policy.MaxToolCalls - usage.toolLeft, Events: events}
		}
	}()
	skillBody, err := loadFixedSkill(ctx, cfg, skillName)
	if err != nil {
		return fail(req.RunID, "skill_unavailable", false, false), nil
	}
	if cfg.SkillsDir != "" {
		versions, err := skillVersionsFor(ctx, cfg)
		if err != nil {
			return fail(req.RunID, "skill_unavailable", false, false), nil
		}
		loadedSkillVersions[skillName] = versions[skillName]
	}
	sys := systemPrompt(req.Mode, coverage)
	if skillBody != "" {
		sys += "\n\n" + skillBody
	}
	messages := []*schema.Message{
		schema.SystemMessage(sys),
		schema.UserMessage(userPrompt(req)),
	}

	msg, err := generateOnce(ctx, cfg, &remaining, req.Policy.MaxOutputTokensPerCall, &events, messages)
	if err != nil {
		code, retryable, unknown := classifyModelError(err)
		return fail(req.RunID, code, retryable, unknown), nil
	}
	result, parseErr := parseModelJSON(msg.Content, req.Mode, coverage)
	if parseErr != nil && remaining > 0 {
		repair := []*schema.Message{
			schema.SystemMessage(systemPrompt(req.Mode, coverage) + " Keep evidence_id and quotes exact. No extra fields."),
			schema.UserMessage("invalid_output: " + parseErr.Error() + "\nOriginal:\n" + string([]rune(msg.Content)[:min(len([]rune(msg.Content)), 4000)])),
		}
		msg, err = generateOnce(ctx, cfg, &remaining, req.Policy.MaxOutputTokensPerCall, &events, repair)
		if err != nil {
			code, retryable, unknown := classifyModelError(err)
			return fail(req.RunID, code, retryable, unknown), nil
		}
		result, parseErr = parseModelJSON(msg.Content, req.Mode, coverage)
	}
	if parseErr != nil {
		return fail(req.RunID, "invalid_output", false, false), nil
	}
	result.Coverage = coverage
	if err := ValidateResult(*result, req.Mode); err != nil {
		return fail(req.RunID, "invalid_output", false, false), nil
	}

	inTok, outTok := usage.usage()
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         req.RunID,
		OK:            true,
		Result:        result,
		Runtime: &Runtime{
			Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: loadedSkillVersions,
			InputTokens: inTok, OutputTokens: outTok,
			ModelCalls: req.Policy.MaxModelCalls - remaining, ToolCalls: req.Policy.MaxToolCalls - usage.toolLeft, Events: events,
		},
		Evidence: sourcesToEvidence(req.Input.Sources),
	}, nil
}

func fail(runID, code string, retryable, unknown bool) ExecuteResponse {
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         runID,
		OK:            false,
		Error:         &ExecuteError{Code: code, Message: code, Retryable: retryable, OutcomeUnknown: unknown},
	}
}

func researchPrompt(coverage Coverage) string {
	return "You are Loom's industry analyst. Use only corpus tools and provided sources. Coverage is " + string(coverage) + ". Call search_items and get_item as needed. Never invent evidence_id. Reply with a single JSON object. Schema: {\"content\":string,\"citations\":[{\"evidence_id\":string,\"quote\":string}],\"insufficient_evidence\":boolean}"
}

func systemPrompt(mode Mode, coverage Coverage) string {
	base := "You are Loom's industry analyst. Use only the provided sources. Reply with a single JSON object. Coverage is " + string(coverage) + " and must not be changed. Do not invent citations. Do not call tools."
	switch mode {
	case ModeAnalyzeItem:
		return base + ` Schema: {"summary":string,"topics":[string],"entities":[string],"insights":string,"tags":[string],"citations":[{"evidence_id":string,"quote":string}],"insufficient_evidence":boolean}`
	case ModeBriefing:
		return base + ` Schema: {"title":string,"content":string,"citations":[{"evidence_id":string,"quote":string}],"insufficient_evidence":boolean}`
	default:
		return base + ` Schema: {"content":string,"citations":[{"evidence_id":string,"quote":string}],"insufficient_evidence":boolean}`
	}
}

func userPrompt(req ExecuteRequest) string {
	var b strings.Builder
	if req.Input.Question != "" {
		fmt.Fprintf(&b, "Question: %s\n", req.Input.Question)
	}
	if req.Input.Range != nil {
		fmt.Fprintf(&b, "Range: [%s, %s)\n", req.Input.Range.From, req.Input.Range.To)
	}
	for i, src := range req.Input.Sources {
		fmt.Fprintf(&b, "\n#%d evidence_id=%s coverage=%s item_id=%s\n%s\n%s\n",
			i+1, src.EvidenceID, src.Coverage, src.ItemID, src.Title, src.Text)
	}
	return b.String()
}

func parseModelJSON(content string, mode Mode, coverage Coverage) (*AgentResult, error) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return nil, fmt.Errorf("empty_content")
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(trimmed)))
	dec.DisallowUnknownFields()
	var parsed modelJSON
	if err := dec.Decode(&parsed); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing_json")
	}
	result := &AgentResult{
		Citations:            parsed.Citations,
		InsufficientEvidence: parsed.InsufficientEvidence,
		Coverage:             coverage,
		Warnings:             parsed.Warnings,
	}
	if result.Citations == nil {
		result.Citations = []EvidenceCitation{}
	}
	if result.Warnings == nil {
		result.Warnings = []string{}
	}
	switch mode {
	case ModeAnalyzeItem:
		analysis := Analysis{
			Summary: parsed.Summary, Topics: parsed.Topics, Entities: parsed.Entities,
			Insights: parsed.Insights, Tags: parsed.Tags,
		}
		if analysis.Topics == nil {
			analysis.Topics = []string{}
		}
		if analysis.Entities == nil {
			analysis.Entities = []string{}
		}
		if analysis.Tags == nil {
			analysis.Tags = []string{}
		}
		result.Analysis = &analysis
	default:
		if strings.TrimSpace(parsed.Content) == "" {
			return nil, fmt.Errorf("empty_content")
		}
		contentCopy := parsed.Content
		result.Content = &contentCopy
		if parsed.Title != "" {
			title := parsed.Title
			result.Title = &title
		}
	}
	return result, nil
}

func sourcesToEvidence(sources []Source) []Evidence {
	out := make([]Evidence, 0, len(sources))
	for _, src := range sources {
		itemID := src.ItemID
		out = append(out, Evidence{
			EvidenceID: src.EvidenceID,
			ItemID:     &itemID,
			Title:      src.Title,
			URL:        src.URL,
			Text:       src.Text,
			Origin:     OriginInternal,
		})
	}
	return out
}
