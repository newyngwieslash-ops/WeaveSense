package opencode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

const bridgeRequestBytes = 64 * 1024
const bridgeResponseBytes = 2 * 1024 * 1024

type BridgeConfig struct {
	AppDataURL      string
	AssistantDataURL string
	AppServiceToken string
	ControlToken    string
	AllowedModel    string
	HTTPClient      *http.Client
}

type Grant struct {
	Grant                  string    `json:"grant"`
	RunID                  string    `json:"run_id"`
	ClaimToken             string    `json:"claim_token"`
	InstanceID             string    `json:"instance_id"`
	Epoch                  string    `json:"epoch"`
	ExpiresAt              time.Time `json:"expires_at"`
	DataAccessToken        string    `json:"data_access_token"`
	Model                  string    `json:"model"`
	PolicyVersion          string    `json:"policy_version"`
	MaxOutputTokensPerCall int       `json:"max_output_tokens_per_call"`
	Profile                string    `json:"profile,omitempty"`
	key                    string
}

type grantEntry struct {
	grant  Grant
	ctx    context.Context
	cancel context.CancelFunc
}

type Bridge struct {
	cfg    BridgeConfig
	mu     sync.RWMutex
	grants map[string]grantEntry
	mcp    http.Handler
}

type bridgeGrantContext struct{}

// assistantReadToolNames is the §3.1 read-only whitelist the assistant
// profile may reach. Research keeps corpus_search_items/corpus_get_item only.
var assistantReadToolNames = []string{
	"project_overview", "list_keywords", "list_sources",
	"search_items", "get_item",
	"list_notes", "get_note", "list_collection_jobs", "get_collection_job",
	"get_research_status", "get_operation", "get_service_status",
}

func assistantToolSchema(name string) json.RawMessage {
	// Per-tool properties (mirrors assistantToolArgWhitelist). Each
	// constraint is unmarshaled before re-marshaling so properties carry
	// nested JSON Schema OBJECTS — encoding them as strings fails the MCP
	// SDK's AssertObjectSchema check and the whole tools/list is rejected.
	constraints := map[string]string{
		"item_id": `{"type":"string","minLength":1,"maxLength":128}`, "note_id": `{"type":"string","minLength":1,"maxLength":128}`,
		"job_id": `{"type":"string","minLength":1,"maxLength":128}`, "action_id": `{"type":"string","minLength":1,"maxLength":128}`,
		// search_items: omitted/empty query = latest-collected listing.
		"query": `{"type":"string","maxLength":200}`, "limit": `{"type":"integer","minimum":1,"maximum":50}`,
	}
	properties := map[string]json.RawMessage{}
	for _, key := range assistantToolArgWhitelist[name] {
		properties[key] = json.RawMessage(constraints[key])
	}
	encoded, err := json.Marshal(properties)
	if err != nil {
		encoded, _ = json.Marshal(map[string]json.RawMessage{})
	}
	return json.RawMessage(`{"type":"object","additionalProperties":false,"properties":` + string(encoded) + `}`)
}

func NewBridge(cfg BridgeConfig) *Bridge {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 8 * time.Second}
	}
	b := &Bridge{cfg: cfg, grants: map[string]grantEntry{}}
	srv := mcpserver.NewMCPServer("WeaveSense corpus", "1", mcpserver.WithToolCapabilities(false))
	search := mcp.NewToolWithRawSchema("search_items", "Search only this run's authorized corpus",
		json.RawMessage(`{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":2,"maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":8}}}`))
	get := mcp.NewToolWithRawSchema("get_item", "Read one authorized corpus fragment; coverage and evidence IDs come from the host",
		json.RawMessage(`{"type":"object","additionalProperties":false,"required":["item_id"],"properties":{"item_id":{"type":"string","minLength":1,"maxLength":256},"start":{"type":"integer","minimum":0,"maximum":9007199254740991}}}`))
	for _, tool := range []mcp.Tool{search, get} {
		tool.Annotations = mcp.ToolAnnotation{ReadOnlyHint: mcp.ToBoolPtr(true), DestructiveHint: mcp.ToBoolPtr(false), OpenWorldHint: mcp.ToBoolPtr(false)}
		srv.AddTool(tool, b.callCorpusTool)
	}
	// Assistant read tools are registered once; per-grant profile filtering
	// happens at tools/list AND tools/call time (filtering the listing alone
	// is not authorization, §4.3). search_items/get_item keep their corpus
	// registration (callCorpusTool routes by profile); the assistant loop
	// skips them so it never overrides their corpus handler.
	for _, name := range assistantReadToolNames {
		if researchTool(name) {
			continue
		}
		tool := mcp.NewToolWithRawSchema(name, "Read this run's authorized project data; the host decides scope",
			assistantToolSchema(name))
		tool.Annotations = mcp.ToolAnnotation{ReadOnlyHint: mcp.ToBoolPtr(true), DestructiveHint: mcp.ToBoolPtr(false), OpenWorldHint: mcp.ToBoolPtr(false)}
		srv.AddTool(tool, b.callAssistantTool)
	}
	b.mcp = mcpserver.NewStreamableHTTPServer(srv, mcpserver.WithStateLess(true), mcpserver.WithDisableStreaming(true))
	return b
}

func (b *Bridge) Handler() http.Handler { return http.HandlerFunc(b.serveHTTP) }

func bridgeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func tokenMatches(header, token string) bool {
	return token != "" && subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+token)) == 1
}

func opaqueKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (b *Bridge) authorizeGrant(req *http.Request) (Grant, bool) {
	header := req.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return Grant{}, false
	}
	key := opaqueKey(strings.TrimPrefix(header, "Bearer "))
	b.mu.RLock()
	entry, ok := b.grants[key]
	b.mu.RUnlock()
	if !ok || !entry.grant.ExpiresAt.After(time.Now()) || entry.ctx.Err() != nil {
		return Grant{}, false
	}
	return entry.grant, true
}

func (b *Bridge) activeEntry(grant Grant) (grantEntry, bool) {
	b.mu.RLock()
	entry, ok := b.grants[grant.key]
	b.mu.RUnlock()
	return entry, ok && entry.grant == grant && entry.grant.ExpiresAt.After(time.Now()) && entry.ctx.Err() == nil
}

func (b *Bridge) serveHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.RawQuery != "" {
		bridgeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if req.URL.Path == "/v1/grants" {
		b.controlGrant(w, req)
		return
	}
	if req.URL.Path != "/mcp" {
		bridgeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	grant, ok := b.authorizeGrant(req)
	if !ok {
		bridgeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(req.Body, bridgeRequestBytes+1))
	if err != nil {
		bridgeJSON(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	if len(raw) > bridgeRequestBytes {
		bridgeJSON(w, 413, map[string]string{"error": "request_too_large"})
		return
	}
	entry, ok := b.activeEntry(grant)
	if !ok {
		bridgeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithDeadline(req.Context(), grant.ExpiresAt)
	stop := context.AfterFunc(entry.ctx, cancel)
	defer func() { stop(); cancel() }()
	req = req.WithContext(context.WithValue(ctx, bridgeGrantContext{}, grant))
	req.Body = io.NopCloser(bytes.NewReader(raw))
	// tools/list must reflect the grant's profile; tools/call re-checks inside
	// the handlers (filtering the listing alone is not authorization, §4.3).
	if grant.profileOf() == "research" {
		b.serveFilteredMCP(w, req, raw, researchListedTools())
		return
	}
	b.serveFilteredMCP(w, req, raw, assistantListedTools())
}

func corpusListEntry(name, description, schema string) map[string]any {
	return map[string]any{"name": name, "description": description,
		"inputSchema": json.RawMessage(schema),
		"annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}
}

func researchListedTools() []map[string]any {
	return []map[string]any{
		corpusListEntry("search_items", "Search only this run's authorized corpus",
			`{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":2,"maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":8}}}`),
		corpusListEntry("get_item", "Read one authorized corpus fragment; coverage and evidence IDs come from the host",
			`{"type":"object","additionalProperties":false,"required":["item_id"],"properties":{"item_id":{"type":"string","minLength":1,"maxLength":256},"start":{"type":"integer","minimum":0,"maximum":9007199254740991}}}`),
	}
}

func assistantListedTools() []map[string]any {
	tools := []map[string]any{}
	for _, name := range assistantReadToolNames {
		description := "Read this run's authorized project data; the host decides scope"
		if name == "search_items" {
			description = "Search this run's authorized project content"
		}
		if name == "get_item" {
			description = "Read one authorized project item fragment"
		}
		tools = append(tools, corpusListEntry(name, description, string(assistantToolSchema(name))))
	}
	return tools
}

// serveFilteredMCP answers tools/list with the profile's exact tool surface
// and delegates everything else to the shared MCP server.
func (b *Bridge) serveFilteredMCP(w http.ResponseWriter, req *http.Request, raw []byte, listed []map[string]any) {
	var probe struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
	}
	if json.Unmarshal(raw, &probe) == nil && probe.Method == "tools/list" && probe.ID != nil {
		bridgeJSON(w, 200, map[string]any{
			"jsonrpc": "2.0", "id": probe.ID,
			"result": map[string]any{"tools": listed},
		})
		return
	}
	b.mcp.ServeHTTP(w, req)
}

var opaqueGrantRE = regexp.MustCompile(`^[a-zA-Z0-9._~-]+$`)
var fixedProfileRE = regexp.MustCompile(`^[a-zA-Z0-9._:/-]+$`)

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func validGrant(grant Grant) bool {
	return validOpaqueGrant(grant.Grant) && canonicalUUID(grant.RunID) && canonicalUUID(grant.ClaimToken) && canonicalUUID(grant.InstanceID) && canonicalUUID(grant.Epoch) &&
		grant.ExpiresAt.After(time.Now()) && time.Until(grant.ExpiresAt) <= 15*time.Minute && validOpaqueGrant(grant.DataAccessToken) && len(grant.DataAccessToken) <= 128 &&
		len(grant.Model) >= 1 && len(grant.Model) <= 128 && fixedProfileRE.MatchString(grant.Model) && len(grant.PolicyVersion) >= 1 && len(grant.PolicyVersion) <= 64 && fixedProfileRE.MatchString(grant.PolicyVersion) &&
		grant.MaxOutputTokensPerCall >= 1 && grant.MaxOutputTokensPerCall <= 8000 &&
		(grant.Profile == "" || grant.Profile == "research" || grant.Profile == "assistant")
}

// profileOf normalizes an omitted profile to research (§4.3: omission is
// strictly research, never an escape hatch).
func (g Grant) profileOf() string {
	if g.Profile == "assistant" {
		return "assistant"
	}
	return "research"
}

// researchTool / assistantTool membership used by both tools/list filtering
// and per-call re-checks.
func researchTool(name string) bool { return name == "search_items" || name == "get_item" }

func assistantTool(name string) bool {
	for _, candidate := range assistantReadToolNames {
		if candidate == name {
			return true
		}
	}
	return false
}

func validOpaqueGrant(token string) bool {
	return len(token) >= 16 && len(token) <= 2048 && opaqueGrantRE.MatchString(token)
}

func strictJSON(raw []byte, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("invalid_json")
	}
	return nil
}

func (b *Bridge) controlGrant(w http.ResponseWriter, req *http.Request) {
	if !tokenMatches(req.Header.Get("Authorization"), b.cfg.ControlToken) {
		bridgeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	if req.Method != http.MethodPost && req.Method != http.MethodDelete {
		bridgeJSON(w, 405, map[string]string{"error": "method_denied"})
		return
	}
	if !strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
		bridgeJSON(w, 400, map[string]string{"error": "json_required"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(req.Body, bridgeRequestBytes+1))
	if err != nil || len(raw) > bridgeRequestBytes {
		bridgeJSON(w, 413, map[string]string{"error": "request_too_large"})
		return
	}
	if req.Method == http.MethodDelete {
		var input struct {
			Grant      *string `json:"grant"`
			InstanceID *string `json:"instance_id"`
			Epoch      *string `json:"epoch"`
		}
		var fields map[string]json.RawMessage
		if strictJSON(raw, &input) != nil || json.Unmarshal(raw, &fields) != nil {
			bridgeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		byGrant := len(fields) == 1 && input.Grant != nil && input.InstanceID == nil && input.Epoch == nil && validOpaqueGrant(*input.Grant)
		byIdentity := len(fields) == 2 && input.Grant == nil && input.InstanceID != nil && input.Epoch != nil && canonicalUUID(*input.InstanceID) && canonicalUUID(*input.Epoch)
		if !byGrant && !byIdentity {
			bridgeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		b.mu.Lock()
		for key, entry := range b.grants {
			if (byGrant && key == opaqueKey(*input.Grant)) || (byIdentity && entry.grant.InstanceID == *input.InstanceID && entry.grant.Epoch == *input.Epoch) {
				entry.cancel()
				// Keep the canceled mapping until its original TTL: neither the old
				// nonce nor a new grant for this revoked epoch can revive its access.
			}
		}
		b.mu.Unlock()
		bridgeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	var grant Grant
	if strictJSON(raw, &grant) != nil || !validGrant(grant) || grant.Grant == b.cfg.ControlToken || grant.Grant == b.cfg.AppServiceToken || grant.Grant == grant.DataAccessToken || (b.cfg.AllowedModel != "" && grant.Model != b.cfg.AllowedModel) {
		bridgeJSON(w, 400, map[string]string{"error": "invalid_grant"})
		return
	}
	grant.key, grant.Grant = opaqueKey(grant.Grant), ""
	b.mu.Lock()
	defer b.mu.Unlock()
	for key, entry := range b.grants {
		if !entry.grant.ExpiresAt.After(time.Now()) {
			entry.cancel()
			delete(b.grants, key)
		}
	}
	if entry, ok := b.grants[grant.key]; ok {
		if entry.grant != grant || entry.ctx.Err() != nil {
			bridgeJSON(w, 409, map[string]string{"error": "grant_conflict"})
		} else {
			bridgeJSON(w, 200, map[string]bool{"ok": true})
		}
		return
	}
	for _, entry := range b.grants {
		if entry.grant.InstanceID == grant.InstanceID && entry.grant.Epoch == grant.Epoch {
			bridgeJSON(w, 409, map[string]string{"error": "grant_conflict"})
			return
		}
	}
	// ponytail: one slot allows 16 live/tombstone grants until original TTL; raise only with measured handoff throughput.
	if len(b.grants) >= 16 {
		bridgeJSON(w, 429, map[string]string{"error": "grant_limit"})
		return
	}
	ctx, cancel := context.WithDeadline(context.Background(), grant.ExpiresAt)
	b.grants[grant.key] = grantEntry{grant: grant, ctx: ctx, cancel: cancel}
	bridgeJSON(w, 201, map[string]bool{"ok": true})
}

// Match host hashCanonical: map keys are sorted, HTML remains text and JS emits
// U+2028/U+2029 literally. Preserve a source's literal backslash-u sequences.
func canonicalJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	raw := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+5 < len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, raw[i], raw[i+1])
			i++
			continue
		}
		out = append(out, raw[i])
	}
	return out, nil
}

func canonicalHash(value any) (string, error) {
	raw, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func toolParameters(name string, args map[string]any) (map[string]any, bool) {
	if args == nil {
		return nil, false
	}
	allowed := map[string]bool{}
	if name == "search_items" {
		if value, exists := args["limit"]; exists && value == nil {
			return nil, false
		}
		allowed["query"], allowed["limit"] = true, true
	} else if name == "get_item" {
		allowed["item_id"], allowed["start"] = true, true
	} else {
		return nil, false
	}
	for key := range args {
		if !allowed[key] {
			return nil, false
		}
	}
	integer := func(value any, fallback, max int64) (int64, bool) {
		if value == nil {
			return fallback, true
		}
		n, ok := value.(float64)
		return int64(n), ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= float64(max) && math.Trunc(n) == n
	}
	if name == "search_items" {
		query, ok := args["query"].(string)
		query = strings.TrimSpace(query)
		limit, valid := integer(args["limit"], 8, 8)
		if !ok || utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 200 || !valid || limit < 1 {
			return nil, false
		}
		return map[string]any{"query": query, "limit": limit}, true
	}
	id, ok := args["item_id"].(string)
	if value, exists := args["start"]; exists && value == nil {
		return nil, false
	}
	start, valid := integer(args["start"], 0, 9007199254740991)
	if !ok || strings.TrimSpace(id) == "" || utf8.RuneCountInString(id) > 256 || !valid {
		return nil, false
	}
	return map[string]any{"item_id": id, "start": start}, true
}

func (b *Bridge) callCorpusTool(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	grant, ok := ctx.Value(bridgeGrantContext{}).(Grant)
	if !ok || !researchTool(req.Params.Name) {
		return mcp.NewToolResultError("tool_denied"), nil
	}
	// search_items/get_item exist on both profiles: research reads the
	// authorized corpus, assistant reads project data. Route by profile.
	if grant.profileOf() == "assistant" {
		return b.callAssistantTool(ctx, req)
	}
	params, valid := toolParameters(req.Params.Name, req.GetArguments())
	if !ok || !valid {
		return mcp.NewToolResultError("tool_denied"), nil
	}
	digest, err := canonicalHash(map[string]any{"tool": req.Params.Name, "params": params})
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_intent"), nil
	}
	callID := uuid.NewString()
	receipt := map[string]any{"call_id": callID, "tool": req.Params.Name, "request_digest": digest}
	ack, err := b.postData(ctx, grant, "tool_start", receipt)
	if err != nil || ack["ok"] != true || ack["disposition"] != "send_once" {
		return mcp.NewToolResultError("tool_admission_denied"), nil
	}
	params["call_id"], params["request_digest"] = callID, digest
	result, err := b.postData(ctx, grant, req.Params.Name, params)
	if err != nil {
		return mcp.NewToolResultError("tool_outcome_unknown"), nil
	}
	resultDigest, err := canonicalHash(result)
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_result"), nil
	}
	receipt["result_digest"] = resultDigest
	ack, err = b.postData(ctx, grant, "tool_complete", receipt)
	if err != nil || ack["ok"] != true {
		return mcp.NewToolResultError("tool_outcome_unknown"), nil
	}
	raw, err := canonicalJSON(result)
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_result"), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

// assistantToolArgWhitelist fixes the args each assistant read tool accepts;
// request-supplied routing (data_url, tokens, profile) can never pass.
var assistantToolArgWhitelist = map[string][]string{
	"project_overview":     {},
	"list_keywords":        {"limit"},
	"list_sources":         {"limit"},
	"search_items":         {"query", "limit"},
	"get_item":             {"item_id"},
	"list_notes":           {"limit"},
	"get_note":             {"note_id"},
	"list_collection_jobs": {"limit"},
	"get_collection_job":   {"job_id"},
	"get_research_status":  {"job_id"},
	"get_operation":        {"action_id"},
	"get_service_status":   {},
}

func assistantToolParameters(name string, args map[string]any) (map[string]any, bool) {
	if args == nil {
		args = map[string]any{}
	}
	allowed := map[string]bool{}
	for _, key := range assistantToolArgWhitelist[name] {
		allowed[key] = true
	}
	params := map[string]any{}
	for key, value := range args {
		if !allowed[key] {
			return nil, false
		}
		params[key] = value
	}
	if name == "search_items" {
		// query is optional: empty = latest-collected listing (host-side).
		if query, exists := params["query"]; exists {
			s, ok := query.(string)
			if !ok || len([]rune(s)) > 200 {
				return nil, false
			}
		}
	}
	return params, true
}

// callAssistantTool serves one read-only assistant tool: same receipted
// start/read/complete discipline as research tools, restricted to assistant
// grants, and always posting to the fixed AppDataURL (§4.3).
func (b *Bridge) callAssistantTool(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	grant, ok := ctx.Value(bridgeGrantContext{}).(Grant)
	if !ok || grant.profileOf() != "assistant" || !assistantTool(req.Params.Name) {
		return mcp.NewToolResultError("tool_denied"), nil
	}
	params, valid := assistantToolParameters(req.Params.Name, req.GetArguments())
	if !valid {
		return mcp.NewToolResultError("tool_denied"), nil
	}
	digest, err := canonicalHash(map[string]any{"tool": req.Params.Name, "params": params})
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_intent"), nil
	}
	callID := uuid.NewString()
	receipt := map[string]any{"call_id": callID, "tool": req.Params.Name, "request_digest": digest}
	ack, err := b.postData(ctx, grant, "tool_start", receipt)
	if err != nil || ack["ok"] != true || ack["disposition"] != "send_once" {
		return mcp.NewToolResultError("tool_admission_denied"), nil
	}
	params["call_id"], params["request_digest"] = callID, digest
	result, err := b.postData(ctx, grant, req.Params.Name, params)
	if err != nil {
		return mcp.NewToolResultError("tool_outcome_unknown"), nil
	}
	resultDigest, err := canonicalHash(result)
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_result"), nil
	}
	receipt["result_digest"] = resultDigest
	ack, err = b.postData(ctx, grant, "tool_complete", receipt)
	if err != nil || ack["ok"] != true {
		return mcp.NewToolResultError("tool_outcome_unknown"), nil
	}
	raw, err := canonicalJSON(result)
	if err != nil {
		return mcp.NewToolResultError("invalid_tool_result"), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func (b *Bridge) postData(ctx context.Context, grant Grant, action string, params any) (map[string]any, error) {
	entry, valid := b.activeEntry(grant)
	// §4.3: assistant grants reach only the fixed assistant-data endpoint;
	// research grants keep the research data URL. An unset assistant URL
	// falls back to AppDataURL (single-endpoint deployments).
	target := b.cfg.AppDataURL
	if grant.profileOf() == "assistant" && b.cfg.AssistantDataURL != "" {
		target = b.cfg.AssistantDataURL
	}
	u, err := url.Parse(target)
	if !valid || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || b.cfg.AppServiceToken == "" {
		return nil, errors.New("app_unavailable")
	}
	raw, err := json.Marshal(map[string]any{"run_id": grant.RunID, "claim_token": grant.ClaimToken, "action": action, "params": params})
	if err != nil || len(raw) > bridgeRequestBytes {
		return nil, errors.New("invalid_app_request")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	stop := context.AfterFunc(entry.ctx, cancel)
	defer func() { stop(); cancel() }()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("app_unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.cfg.AppServiceToken)
	req.Header.Set("X-Agent-Run-Token", grant.DataAccessToken)
	client := *b.cfg.HTTPClient
	if client.Timeout <= 0 || client.Timeout > 8*time.Second {
		client.Timeout = 8 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("app_unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 || !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		return nil, errors.New("app_denied")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, bridgeResponseBytes+1))
	if err != nil || len(body) > bridgeResponseBytes {
		return nil, errors.New("app_response_too_large")
	}
	var result map[string]any
	if strictJSON(body, &result) != nil || result == nil {
		return nil, errors.New("invalid_app_response")
	}
	return result, nil
}
