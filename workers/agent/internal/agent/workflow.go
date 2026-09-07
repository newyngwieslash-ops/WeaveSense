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

func Execute(ctx context.Context, cfg Config, req ExecuteRequest) (ExecuteResponse, error) {
	if err := ValidateRequest(req); err != nil {
		return fail(req.RunID, "invalid_request", false, false), nil
	}
	coverage := CoverageFull
	for _, src := range req.Input.Sources {
		if src.Coverage == CoveragePartial {
			coverage = CoveragePartial
		}
	}
	remaining := req.Policy.MaxModelCalls
	if remaining <= 0 {
		remaining = 1
	}
	events := make([]RuntimeEvent, 0, 8)
	messages := []*schema.Message{
		schema.SystemMessage(systemPrompt(req.Mode, coverage)),
		schema.UserMessage(userPrompt(req)),
	}

	msg, err := generateOnce(ctx, cfg, &remaining, &events, messages)
	if err != nil {
		code, retryable, unknown := classifyModelError(err)
		return fail(req.RunID, code, retryable, unknown), nil
	}
	result, parseErr := parseModelJSON(msg.Content, req.Mode, coverage)
	if parseErr != nil && remaining > 0 {
		repair := []*schema.Message{
			schema.SystemMessage("Return only one JSON object matching the required schema. Do not include markdown."),
			schema.UserMessage("invalid_output: " + parseErr.Error() + "\nRequired keys only. No extra fields."),
		}
		msg, err = generateOnce(ctx, cfg, &remaining, &events, repair)
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

	var inTok, outTok *int
	if msg != nil && msg.ResponseMeta != nil && msg.ResponseMeta.Usage != nil {
		p := msg.ResponseMeta.Usage.PromptTokens
		c := msg.ResponseMeta.Usage.CompletionTokens
		// ponytail: openai adapter fills Usage with 0 when the vendor omits it; treat 0/0 as unknown instead of a real zero-cost call.
		if p != 0 || c != 0 {
			inTok, outTok = &p, &c
		}
	}
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         req.RunID,
		OK:            true,
		Result:        result,
		Runtime: &Runtime{
			Model: cfg.ModelName, PromptVersion: promptVersion, SkillVersions: map[string]string{},
			InputTokens: inTok, OutputTokens: outTok,
			ModelCalls: req.Policy.MaxModelCalls - remaining, ToolCalls: 0, Events: events,
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
