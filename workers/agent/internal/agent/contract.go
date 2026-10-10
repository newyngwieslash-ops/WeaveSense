package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const schemaVersion = 1

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Coverage string

const (
	CoverageFull    Coverage = "full"
	CoveragePartial Coverage = "partial"
)

type Origin string

const (
	OriginInternal Origin = "internal"
	OriginMCP      Origin = "mcp"
)

type Mode string

const (
	ModeAnalyzeItem Mode = "analyze_item"
	ModeBriefing    Mode = "briefing"
	ModeResearch    Mode = "research"
)

type Source struct {
	EvidenceID  string   `json:"evidence_id"`
	ItemID      string   `json:"item_id"`
	Title       string   `json:"title"`
	Platform    string   `json:"platform"`
	SourceName  string   `json:"source_name"`
	URL         string   `json:"url"`
	PublishedAt *string  `json:"published_at"`
	Text        string   `json:"text"`
	Start       int      `json:"start"`
	End         int      `json:"end"`
	Coverage    Coverage `json:"coverage"`
}

type DateRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type ExecuteInput struct {
	Question string     `json:"question"`
	Sources  []Source   `json:"sources"`
	Range    *DateRange `json:"range"`
}

type Policy struct {
	Version                string `json:"version"`
	DeadlineAt             string `json:"deadline_at"`
	MaxModelCalls          int    `json:"max_model_calls"`
	MaxToolCalls           int    `json:"max_tool_calls"`
	MaxOutputTokensPerCall int    `json:"max_output_tokens_per_call"`
}

type ExecuteRequest struct {
	SchemaVersion   int          `json:"schema_version"`
	RunID           string       `json:"run_id"`
	Mode            Mode         `json:"mode"`
	Input           ExecuteInput `json:"input"`
	Policy          Policy       `json:"policy"`
	DataAccessToken string       `json:"data_access_token,omitempty"`
}

type Analysis struct {
	Summary  string   `json:"summary"`
	Topics   []string `json:"topics"`
	Entities []string `json:"entities"`
	Insights string   `json:"insights"`
	Tags     []string `json:"tags"`
}

type EvidenceCitation struct {
	EvidenceID string `json:"evidence_id"`
	Quote      string `json:"quote"`
}

type RuntimeEvent struct {
	Type       string `json:"type"`
	Name       string `json:"name"`
	DurationMS int    `json:"duration_ms"`
	OK         bool   `json:"ok"`
}

type Runtime struct {
	Model         string            `json:"model"`
	PromptVersion string            `json:"prompt_version"`
	SkillVersions map[string]string `json:"skill_versions"`
	InputTokens   *int              `json:"input_tokens"`
	OutputTokens  *int              `json:"output_tokens"`
	ModelCalls    int               `json:"model_calls"`
	ToolCalls     int               `json:"tool_calls"`
	Events        []RuntimeEvent    `json:"events"`
}

type Evidence struct {
	EvidenceID string  `json:"evidence_id"`
	ItemID     *string `json:"item_id"`
	Title      string  `json:"title"`
	URL        string  `json:"url"`
	Text       string  `json:"text"`
	Origin     Origin  `json:"origin"`
}

type AgentResult struct {
	Analysis             *Analysis          `json:"analysis,omitempty"`
	Title                *string            `json:"title,omitempty"`
	Content              *string            `json:"content,omitempty"`
	Citations            []EvidenceCitation `json:"citations"`
	InsufficientEvidence bool               `json:"insufficient_evidence"`
	Coverage             Coverage           `json:"coverage"`
	Warnings             []string           `json:"warnings"`
}

type ExecuteError struct {
	Code           string `json:"code"`
	Message        string `json:"message"`
	Retryable      bool   `json:"retryable"`
	OutcomeUnknown bool   `json:"outcome_unknown"`
}

type ExecuteResponse struct {
	SchemaVersion int           `json:"schema_version"`
	RunID         string        `json:"run_id"`
	OK            bool          `json:"ok"`
	Result        *AgentResult  `json:"result,omitempty"`
	Runtime       *Runtime      `json:"runtime,omitempty"`
	Evidence      []Evidence    `json:"evidence,omitzero"`
	Error         *ExecuteError `json:"error,omitempty"`
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

func decodeStrict(data []byte, dest any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("trailing_json")
		}
		return fmt.Errorf("trailing_json: %w", err)
	}
	return nil
}

func requireUUID(id string) error {
	if !uuidRE.MatchString(id) {
		return errors.New("invalid_uuid")
	}
	return nil
}

func requireTime(value string) error {
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return fmt.Errorf("invalid_time: %w", err)
	}
	return nil
}

func requireBounded(s string, max int) error {
	if runeLen(s) > max {
		return errors.New("too_long")
	}
	return nil
}

func requireLabels(values []string) error {
	if len(values) > 12 {
		return errors.New("too_many_labels")
	}
	for _, v := range values {
		if strings.TrimSpace(v) == "" || runeLen(v) > 80 {
			return errors.New("invalid_label")
		}
	}
	return nil
}

func ValidateAnalysis(a Analysis) error {
	if strings.TrimSpace(a.Summary) == "" || runeLen(a.Summary) > 1200 {
		return errors.New("invalid_summary")
	}
	if runeLen(a.Insights) > 1200 {
		return errors.New("invalid_insights")
	}
	for _, labels := range [][]string{a.Topics, a.Entities, a.Tags} {
		if err := requireLabels(labels); err != nil {
			return err
		}
	}
	return nil
}

func ValidateRequest(req ExecuteRequest) error {
	if req.SchemaVersion != schemaVersion {
		return errors.New("invalid_schema_version")
	}
	if err := requireUUID(req.RunID); err != nil {
		return err
	}
	switch req.Mode {
	case ModeAnalyzeItem, ModeBriefing, ModeResearch:
	default:
		return errors.New("unknown_mode")
	}
	if err := requireBounded(req.Policy.Version, 64); err != nil || strings.TrimSpace(req.Policy.Version) == "" {
		return errors.New("invalid_policy")
	}
	if err := requireTime(req.Policy.DeadlineAt); err != nil {
		return err
	}
	if req.Policy.MaxModelCalls < 0 || req.Policy.MaxToolCalls < 0 || req.Policy.MaxOutputTokensPerCall < 1 {
		return errors.New("invalid_policy")
	}
	if len(req.Input.Sources) > 12 {
		return errors.New("too_many_sources")
	}
	itemIDs := map[string]struct{}{}
	for _, src := range req.Input.Sources {
		if strings.TrimSpace(src.EvidenceID) == "" || strings.TrimSpace(src.ItemID) == "" {
			return errors.New("invalid_source")
		}
		if src.Coverage != CoverageFull && src.Coverage != CoveragePartial {
			return errors.New("invalid_coverage")
		}
		if src.End < src.Start || src.End-src.Start != runeLen(src.Text) {
			return errors.New("source_span_mismatch")
		}
		if src.PublishedAt != nil {
			if err := requireTime(*src.PublishedAt); err != nil {
				return err
			}
		}
		itemIDs[src.ItemID] = struct{}{}
	}
	switch req.Mode {
	case ModeAnalyzeItem:
		if len(req.Input.Sources) == 0 {
			return errors.New("empty_evidence")
		}
		if len(itemIDs) != 1 {
			return errors.New("mixed_items")
		}
	case ModeBriefing:
		if req.Input.Range == nil {
			return errors.New("range_required")
		}
		if err := requireTime(req.Input.Range.From); err != nil {
			return err
		}
		if err := requireTime(req.Input.Range.To); err != nil {
			return err
		}
		from, _ := time.Parse(time.RFC3339, req.Input.Range.From)
		to, _ := time.Parse(time.RFC3339, req.Input.Range.To)
		if !from.Before(to) {
			return errors.New("invalid_date_range")
		}
	case ModeResearch:
		n := runeLen(strings.TrimSpace(req.Input.Question))
		if n < 2 || n > 400 {
			return errors.New("invalid_question")
		}
	}
	return nil
}

func ValidateResult(result AgentResult, mode Mode) error {
	if result.Coverage != CoverageFull && result.Coverage != CoveragePartial {
		return errors.New("invalid_coverage")
	}
	if len(result.Citations) > 20 || len(result.Warnings) > 12 {
		return errors.New("too_many_citations")
	}
	for _, c := range result.Citations {
		if strings.TrimSpace(c.EvidenceID) == "" || strings.TrimSpace(c.Quote) == "" || runeLen(c.Quote) > 500 {
			return errors.New("invalid_citation")
		}
	}
	switch mode {
	case ModeAnalyzeItem:
		if result.Analysis == nil || result.Content != nil || result.Title != nil {
			return errors.New("cross_mode_output")
		}
		return ValidateAnalysis(*result.Analysis)
	default:
		if result.Analysis != nil || result.Content == nil || strings.TrimSpace(*result.Content) == "" || runeLen(*result.Content) > 12000 {
			return errors.New("cross_mode_output")
		}
		if result.Title != nil && runeLen(*result.Title) > 200 {
			return errors.New("invalid_title")
		}
	}
	return nil
}

func ValidateResponse(resp ExecuteResponse, mode Mode) error {
	if resp.SchemaVersion != schemaVersion {
		return errors.New("invalid_schema_version")
	}
	if err := requireUUID(resp.RunID); err != nil {
		return err
	}
	if !resp.OK {
		if resp.Error == nil || strings.TrimSpace(resp.Error.Code) == "" || strings.TrimSpace(resp.Error.Message) == "" {
			return errors.New("invalid_error")
		}
		if resp.Result != nil {
			return errors.New("error_has_result")
		}
		return nil
	}
	if resp.Result == nil || resp.Runtime == nil {
		return errors.New("missing_result")
	}
	if resp.Runtime.SkillVersions == nil || len(resp.Runtime.Events) > 64 || len(resp.Evidence) > 32 {
		return errors.New("invalid_runtime")
	}
	if resp.Runtime.ModelCalls < 0 || resp.Runtime.ToolCalls < 0 {
		return errors.New("invalid_runtime")
	}
	for _, ev := range resp.Evidence {
		if strings.TrimSpace(ev.EvidenceID) == "" {
			return errors.New("invalid_evidence")
		}
		if ev.Origin != OriginInternal && ev.Origin != OriginMCP {
			return errors.New("invalid_origin")
		}
		if ev.URL != "" {
			u, err := url.Parse(ev.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "") {
				return errors.New("invalid_url")
			}
		}
	}
	return ValidateResult(*resp.Result, mode)
}

func ParseExecuteRequest(data []byte) (ExecuteRequest, error) {
	var req ExecuteRequest
	if err := decodeStrict(data, &req); err != nil {
		return req, err
	}
	return req, ValidateRequest(req)
}

func ParseExecuteResponse(data []byte, mode Mode) (ExecuteResponse, error) {
	var resp ExecuteResponse
	if err := decodeStrict(data, &resp); err != nil {
		return resp, err
	}
	return resp, ValidateResponse(resp, mode)
}

func ParseAnalysis(data []byte) (Analysis, error) {
	var analysis Analysis
	if err := decodeStrict(data, &analysis); err != nil {
		return analysis, err
	}
	return analysis, ValidateAnalysis(analysis)
}

// --- Assistant result contract (plan §5.2/§4.3) ----------------------------

// AssistantAction mirrors the browser-contract write-action union. Unknown
// fields are refused by decodeStrict; the host, not the model, executes.
type AssistantAction struct {
	Ordinal int             `json:"ordinal"`
	Kind    string          `json:"kind"`
	Args    json.RawMessage `json:"args"`
}

type AssistantReference struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type AssistantClarification struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

type AssistantResult struct {
	Version       int                     `json:"version"`
	Answer        string                  `json:"answer"`
	Citations     []AssistantReference    `json:"citations"`
	Actions       []AssistantAction       `json:"actions"`
	Clarification *AssistantClarification `json:"clarification,omitempty"`
}

var assistantActionKinds = map[string]bool{
	"keyword.create": true, "keyword.update": true, "keyword.set_enabled": true, "keyword.collect_once": true,
	"source.create": true, "source.set_enabled": true, "source.collect_once": true,
	"research.start": true, "research.cancel": true,
}

func ValidateAssistantResult(result AssistantResult) error {
	if result.Version != schemaVersion {
		return errors.New("invalid_schema_version")
	}
	n := runeLen(strings.TrimSpace(result.Answer))
	if n < 1 || n > 12000 {
		return errors.New("invalid_answer")
	}
	if len(result.Citations) > 12 || len(result.Actions) > 4 {
		return errors.New("assistant_result_too_large")
	}
	var citationKinds = map[string]bool{
		"item": true, "source": true, "keyword": true, "note": true,
		"collection_job": true, "research_job": true,
	}
	for _, c := range result.Citations {
		if !citationKinds[c.Kind] || strings.TrimSpace(c.ID) == "" || runeLen(c.ID) > 128 {
			return errors.New("invalid_citation")
		}
	}
	argKeys := map[string][]string{
		"keyword.create":       {"keyword", "platforms", "interval", "enabled"},
		"keyword.update":       {"keyword_id", "interval", "platforms"},
		"keyword.set_enabled":  {"keyword_id", "enabled"},
		"keyword.collect_once": {"keyword_id", "source_id", "keyword", "source"},
		"source.create":        {"url", "enabled"},
		"source.set_enabled":   {"source_id", "enabled"},
		"source.collect_once":  {"keyword_id", "source_id", "keyword", "source"},
		"research.start":       {"question"},
		"research.cancel":      {"job_id"},
	}
	for i, a := range result.Actions {
		if a.Ordinal != i || !assistantActionKinds[a.Kind] || len(a.Args) == 0 {
			return errors.New("invalid_assistant_action")
		}
		var args map[string]json.RawMessage
		dec := json.NewDecoder(bytes.NewReader(a.Args))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&args); err != nil {
			return errors.New("invalid_assistant_action_args")
		}
		allowed := map[string]bool{}
		for _, k := range argKeys[a.Kind] { allowed[k] = true }
		for k := range args {
			if !allowed[k] { return errors.New("invalid_assistant_action_args") }
		}
		if len(args) == 0 { return errors.New("invalid_assistant_action_args") }
	}
	if result.Clarification != nil && len(result.Actions) > 0 {
		return errors.New("clarification_xor_actions")
	}
	if result.Clarification != nil {
		if strings.TrimSpace(result.Clarification.Question) == "" || len(result.Clarification.Options) < 2 || len(result.Clarification.Options) > 6 {
			return errors.New("invalid_clarification")
		}
	}
	return nil
}

func ParseAssistantResult(data []byte) (AssistantResult, error) {
	var result AssistantResult
	if err := decodeStrict(data, &result); err != nil {
		return result, err
	}
	// Models sometimes emit explicit JSON null for empty collections. The
	// host schema requires arrays; normalize nil to empty so the accepted
	// payload set matches the zod decoder (an empty collection is
	// semantically identical to a null one).
	if result.Citations == nil {
		result.Citations = []AssistantReference{}
	}
	if result.Actions == nil {
		result.Actions = []AssistantAction{}
	}
	return result, ValidateAssistantResult(result)
}
