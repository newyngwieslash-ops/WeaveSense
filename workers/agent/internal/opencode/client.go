package opencode

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"loom.local/agent/internal/agent"
)

const RuntimeVersion = "1.3.13"
const OpenAPIDigest = "5d1b724068d39e8a706617545db42bc51850ce611da37f03fcfab7f77a26316e"
const MaxRuntimeBytes = 4 * 1024 * 1024

var sessionRE = regexp.MustCompile(`^ses_[a-zA-Z0-9]+$`)
var messageRE = regexp.MustCompile(`^msg_[a-zA-Z0-9]+$`)
var digestRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Binding struct {
	InstanceID string `json:"instance_id"`
	Epoch      string `json:"epoch"`
	SessionID  string `json:"session_id,omitempty"`
}
type RuntimeState struct {
	Binding
	RunID               string            `json:"run_id"`
	Version             string            `json:"version"`
	ConfigDigest        string            `json:"config_digest"`
	SkillSnapshotDigest string            `json:"skill_snapshot_digest"`
	SkillVersions       map[string]string `json:"skill_versions"`
	Status              string            `json:"status"`
	Profile             string            `json:"profile,omitempty"`
	DispatchState       string            `json:"dispatch_state"`
	ProcessRunning      bool              `json:"process_running"`
	Stopped             bool              `json:"stopped,omitempty"`
}
type Client struct {
	base, token string
	http        *http.Client
}

func trustedURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("invalid_trusted_url")
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}
func NewClient(base, token string, transport http.RoundTripper) (*Client, error) {
	fixed, err := trustedURL(base)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(fixed)
	if u.Path != "" || !validOpaqueGrant(token) {
		return nil, errors.New("invalid_runtime_config")
	}
	return &Client{base: fixed, token: token, http: &http.Client{Transport: transport, Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxRuntimeBytes+1))
	if err != nil {
		return nil, res.StatusCode, err
	}
	if len(data) > MaxRuntimeBytes {
		return nil, res.StatusCode, errors.New("runtime_response_too_large")
	}
	if res.StatusCode == 204 {
		return nil, 204, nil
	}
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") || !json.Valid(data) {
		return nil, res.StatusCode, errors.New("runtime_non_json")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, res.StatusCode, fmt.Errorf("runtime_status_%d", res.StatusCode)
	}
	return data, res.StatusCode, nil
}
func (c *Client) Health(ctx context.Context) error {
	raw, _, err := c.request(ctx, "GET", "/health", nil)
	if err != nil {
		return err
	}
	var h struct {
		Healthy bool   `json:"healthy"`
		Version string `json:"version"`
	}
	if strictJSON(raw, &h) != nil || !h.Healthy || h.Version != RuntimeVersion {
		return errors.New("runtime_version_mismatch")
	}
	return nil
}
func validBinding(b Binding) bool { return canonicalUUID(b.InstanceID) && canonicalUUID(b.Epoch) }
func identity(b Binding) map[string]string {
	return map[string]string{"instance_id": b.InstanceID, "epoch": b.Epoch}
}
func decodeState(raw []byte, b *Binding) (RuntimeState, error) {
	var s RuntimeState
	if strictJSON(raw, &s) != nil || s.Version != RuntimeVersion || !validBinding(s.Binding) {
		return s, errors.New("invalid_runtime_state")
	}
	if b != nil && (b.InstanceID != s.InstanceID || b.Epoch != s.Epoch) {
		return s, errors.New("stale_epoch")
	}
	return s, nil
}
func (c *Client) Prepare(ctx context.Context, runID, grant, claim string) (RuntimeState, error) {
	return c.PrepareProfile(ctx, runID, grant, claim, "research")
}

// PrepareProfile carries the trusted host profile with the prepare request.
// Research (the default) keeps its original three-skill manifest check; the
// assistant profile must present exactly its own single approved skill, so a
// prepared response from the wrong profile can never be swapped in (§4.3).
func (c *Client) PrepareProfile(ctx context.Context, runID, grant, claim, profile string) (RuntimeState, error) {
	if profile != "research" && profile != "assistant" {
		return RuntimeState{}, errors.New("invalid_profile")
	}
	raw, _, err := c.request(ctx, "POST", "/prepare", map[string]string{"run_id": runID, "grant": grant, "claim_token": claim, "profile": profile})
	if err != nil {
		return RuntimeState{}, err
	}
	s, err := decodeState(raw, nil)
	if err == nil {
		wantSkills := 3
		if profile == "assistant" {
			wantSkills = 1
		}
		if s.RunID != runID || s.Status != "prepared" || !digestRE.MatchString(s.ConfigDigest) || !digestRE.MatchString(s.SkillSnapshotDigest) || len(s.SkillVersions) != wantSkills {
			err = errors.New("invalid_prepared_binding")
		} else if profile == "assistant" {
			if _, ok := s.SkillVersions["project-assistant"]; !ok {
				err = errors.New("invalid_prepared_binding")
			}
		} else if _, mixed := s.SkillVersions["project-assistant"]; mixed {
			err = errors.New("invalid_prepared_binding")
		}
	}
	return s, err
}
func (c *Client) Start(ctx context.Context, b Binding) (RuntimeState, error) {
	if !validBinding(b) {
		return RuntimeState{}, errors.New("invalid_binding")
	}
	raw, _, err := c.request(ctx, "POST", "/start", identity(b))
	if err != nil {
		return RuntimeState{}, err
	}
	return decodeState(raw, &b)
}
func (c *Client) Status(ctx context.Context, b Binding) (RuntimeState, error) {
	if !validBinding(b) {
		return RuntimeState{}, errors.New("invalid_binding")
	}
	raw, _, err := c.request(ctx, "GET", "/status?instance_id="+url.QueryEscape(b.InstanceID)+"&epoch="+url.QueryEscape(b.Epoch), nil)
	if err != nil {
		return RuntimeState{}, err
	}
	return decodeState(raw, &b)
}
func (c *Client) Stop(ctx context.Context, b Binding) error {
	if !validBinding(b) {
		return errors.New("invalid_binding")
	}
	raw, _, err := c.request(ctx, "POST", "/stop", identity(b))
	if err != nil {
		return err
	}
	s, err := decodeState(raw, &b)
	if err != nil {
		return err
	}
	if !s.Stopped || s.ProcessRunning || s.Status != "stopped" {
		return errors.New("process_tree_stop_unconfirmed")
	}
	return nil
}
func validRoute(b Binding, method, path string) bool {
	if !validBinding(b) {
		return false
	}
	if method == "POST" && path == "/session" {
		return true
	}
	if method == "GET" && (path == "/session/status" || path == "/event") {
		return true
	}
	if !sessionRE.MatchString(b.SessionID) {
		return false
	}
	prefix := "/session/" + b.SessionID
	return method == "GET" && path == prefix+"/message" || method == "POST" && (path == prefix+"/abort" || path == prefix+"/prompt_async")
}
func forwardBody(b Binding, method, path string, body any) map[string]any {
	out := map[string]any{"instance_id": b.InstanceID, "epoch": b.Epoch, "method": method, "path": path}
	if body != nil {
		out["body"] = body
	}
	return out
}
func (c *Client) Forward(ctx context.Context, b Binding, method, path string, body any) ([]byte, int, error) {
	if !validRoute(b, method, path) || path == "/event" {
		return nil, 0, errors.New("forbidden_runtime_route")
	}
	return c.request(ctx, "POST", "/forward", forwardBody(b, method, path, body))
}
func (c *Client) Session(ctx context.Context, b Binding) (string, error) {
	raw, _, err := c.Forward(ctx, b, "POST", "/session", map[string]string{"title": "Corpus research"})
	if err != nil {
		return "", err
	}
	var s struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &s) != nil || !sessionRE.MatchString(s.ID) {
		return "", errors.New("invalid_runtime_session")
	}
	return s.ID, nil
}
func (c *Client) Prompt(ctx context.Context, b Binding, text string) error {
	_, status, err := c.Forward(ctx, b, "POST", "/session/"+b.SessionID+"/prompt_async", map[string]any{"parts": []any{map[string]string{"type": "text", "text": text}}})
	if err != nil {
		return err
	}
	if status != 204 {
		return errors.New("prompt_submission_unknown")
	}
	return nil
}
func (c *Client) Abort(ctx context.Context, b Binding) error {
	raw, _, err := c.Forward(ctx, b, "POST", "/session/"+b.SessionID+"/abort", map[string]any{})
	if err != nil {
		return err
	}
	if string(bytes.TrimSpace(raw)) != "true" {
		return errors.New("abort_unconfirmed")
	}
	return nil
}

// Observe never changes lifecycle or publishes; disconnected streams are advisory errors.
func (c *Client) Observe(ctx context.Context, b Binding, onEvent func(json.RawMessage)) error {
	if !validRoute(b, "GET", "/event") {
		return errors.New("invalid_binding")
	}
	raw, _ := json.Marshal(forwardBody(b, "GET", "/event", nil))
	req, _ := http.NewRequestWithContext(ctx, "POST", c.base+"/forward", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	client := *c.http
	client.Timeout = 0
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		return errors.New("invalid_runtime_event_stream")
	}
	scan := bufio.NewScanner(res.Body)
	scan.Buffer(make([]byte, 4096), 256*1024)
	seen := map[[32]byte]bool{}
	for scan.Scan() {
		line := scan.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := []byte(strings.TrimPrefix(line, "data: "))
		var event struct {
			Type       string `json:"type"`
			Properties struct {
				SessionID string `json:"sessionID"`
			} `json:"properties"`
		}
		if json.Unmarshal(data, &event) != nil {
			return errors.New("invalid_runtime_event")
		}
		if event.Properties.SessionID != "" && event.Properties.SessionID != b.SessionID {
			return errors.New("foreign_session_event")
		}
		key := sha256.Sum256(data)
		if seen[key] {
			continue
		}
		if len(seen) >= 1024 {
			return errors.New("event_limit")
		}
		seen[key] = true
		onEvent(append(json.RawMessage(nil), data...))
	}
	if err := scan.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

// TerminalResult trusts neither idle nor text events. It validates a completed,
// own-session assistant turn against the locked 1.3.13 message shape and host contract.
func TerminalResult(raw []byte, session, model string) (*agent.AgentResult, bool, error) {
	if len(raw) > MaxRuntimeBytes || !sessionRE.MatchString(session) {
		return nil, false, errors.New("invalid_messages")
	}
	type part struct {
		Type, Text string
		SessionID  string `json:"sessionID"`
		MessageID  string `json:"messageID"`
	}
	type info struct {
		ID, Role, Agent, Finish string
		SessionID               string          `json:"sessionID"`
		ProviderID              string          `json:"providerID"`
		ModelID                 string          `json:"modelID"`
		Error                   json.RawMessage `json:"error"`
		Time                    struct {
			Completed int64 `json:"completed"`
		} `json:"time"`
	}
	var messages []struct {
		Info  info   `json:"info"`
		Parts []part `json:"parts"`
	}
	if json.Unmarshal(raw, &messages) != nil || len(messages) > 256 {
		return nil, false, errors.New("invalid_messages")
	}
	var last int = -1
	for i, m := range messages {
		if m.Info.SessionID != session || !messageRE.MatchString(m.Info.ID) {
			return nil, false, errors.New("foreign_session_message")
		}
		for _, p := range m.Parts {
			if p.SessionID != session || p.MessageID != m.Info.ID {
				return nil, false, errors.New("foreign_message_part")
			}
		}
		if m.Info.Role == "assistant" {
			last = i
		}
	}
	if last < 0 {
		return nil, false, nil
	}
	m := messages[last]
	if len(m.Info.Error) > 0 && string(m.Info.Error) != "null" {
		return nil, false, errors.New("runtime_model_error")
	}
	if m.Info.Time.Completed <= 0 || m.Info.Finish == "" || m.Info.Finish == "tool-calls" || m.Info.Finish == "unknown" {
		return nil, false, nil
	}
	if m.Info.Finish != "stop" || m.Info.Agent != "research" || m.Info.ProviderID != "bridge" || m.Info.ModelID != model {
		return nil, false, errors.New("invalid_terminal_message")
	}
	var texts []string
	for _, p := range m.Parts {
		if p.Type == "text" {
			texts = append(texts, p.Text)
		}
	}
	if len(texts) != 1 || len(texts[0]) > agent.MaxResponseBytes {
		return nil, false, errors.New("invalid_terminal_result")
	}
	var result agent.AgentResult
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(texts[0]), &fields) != nil {
		return nil, false, errors.New("invalid_terminal_result")
	}
	for _, name := range []string{"content", "citations", "coverage", "insufficient_evidence", "warnings"} {
		if len(fields[name]) == 0 || string(fields[name]) == "null" {
			return nil, false, errors.New("missing_terminal_field")
		}
	}
	if strictJSON([]byte(texts[0]), &result) != nil {
		return nil, false, errors.New("invalid_terminal_result")
	}
	if err := agent.ValidateResult(result, agent.ModeResearch); err != nil {
		return nil, false, err
	}
	return &result, true, nil
}

// AssistantProgress is the live view the panel renders while a turn runs:
// which tools have been called with what state, and the tail of the model's
// reasoning. Extracted from the same /message payload the terminal decoder
// reads; nil-safe on malformed payloads (progress is best-effort).
type AssistantProgress struct {
	Tools      []AssistantToolStage `json:"tools"`
	ReasonTail string               `json:"reason_tail,omitempty"`
}

type AssistantToolStage struct {
	CallID string `json:"call_id"`
	Tool   string `json:"tool"`
	State  string `json:"state"` // pending|running|completed|error
}

// AssistantProgressOf walks the message list in order and folds every tool
// part into its latest state, plus the tail of the newest reasoning text.
func AssistantProgressOf(raw []byte, session string) AssistantProgress {
	var progress AssistantProgress
	var tools []AssistantToolStage
	reasonTail := ""
	var messages []struct {
		Info struct {
			SessionID string `json:"sessionID"`
		} `json:"info"`
		Parts []struct {
			Type   string `json:"type"`
			Text   string `json:"text"`
			CallID string `json:"callID"`
			Tool   string `json:"tool"`
			State  struct {
				Status string `json:"status"`
			} `json:"state"`
		} `json:"parts"`
	}
	if json.Unmarshal(raw, &messages) != nil {
		return progress
	}
	for _, m := range messages {
		if m.Info.SessionID != session {
			continue
		}
		for _, p := range m.Parts {
			switch p.Type {
			case "tool":
				if p.CallID == "" || p.Tool == "" {
					continue
				}
				updated := false
				for i := range tools {
					if tools[i].CallID == p.CallID {
						tools[i].Tool, tools[i].State = p.Tool, p.State.Status
						updated = true
						break
					}
				}
				if !updated {
					tools = append(tools, AssistantToolStage{CallID: p.CallID, Tool: p.Tool, State: p.State.Status})
				}
			case "reasoning":
				if p.Text != "" {
					reasonTail = p.Text
				}
			}
		}
	}
	if len(tools) > 12 {
		tools = tools[len(tools)-12:]
	}
	const reasonTailMax = 600
	if len(reasonTail) > reasonTailMax {
		reasonTail = reasonTail[len(reasonTail)-reasonTailMax:]
	}
	progress.Tools, progress.ReasonTail = tools, reasonTail
	return progress
}

// AssistantTerminalResult is the §4.3 sibling of TerminalResult: it validates
// an assistant-profile turn (agent='assistant') whose final text must parse as
// the host's AssistantResult contract. The research decoder refuses assistant
// messages and vice versa, so a profile swap cannot smuggle a payload through.
func AssistantTerminalResult(raw []byte, session, model string) (*agent.AssistantResult, bool, error) {
	if len(raw) > MaxRuntimeBytes || !sessionRE.MatchString(session) {
		return nil, false, errors.New("invalid_messages")
	}
	type infoShape = struct {
		ID, Role, Agent, Finish string
		SessionID               string          `json:"sessionID"`
		ProviderID              string          `json:"providerID"`
		ModelID                 string          `json:"modelID"`
		Error                   json.RawMessage `json:"error"`
		Time                    struct {
			Completed int64 `json:"completed"`
		} `json:"time"`
	}
	type partShape = struct {
		Type, Text string
		SessionID  string `json:"sessionID"`
		MessageID  string `json:"messageID"`
	}
	var payload struct {
		Messages []struct {
			Info  infoShape
			Parts []partShape
		}
	}
	// Accept either the raw array or an event-wrapped envelope.
	var rawMessages []struct {
		Info  json.RawMessage `json:"info"`
		Parts json.RawMessage `json:"parts"`
	}
	if json.Unmarshal(raw, &rawMessages) != nil || len(rawMessages) > 256 {
		return nil, false, errors.New("invalid_messages")
	}
	var last = -1
	for i, m := range rawMessages {
		var info struct {
			ID, Role, Agent, Finish string
			SessionID               string          `json:"sessionID"`
			ProviderID              string          `json:"providerID"`
			ModelID                 string          `json:"modelID"`
			Error                   json.RawMessage `json:"error"`
			Time                    struct {
				Completed int64 `json:"completed"`
			} `json:"time"`
		}
		if json.Unmarshal(m.Info, &info) != nil {
			return nil, false, errors.New("invalid_messages")
		}
		if info.SessionID != session || !messageRE.MatchString(info.ID) {
			return nil, false, errors.New("foreign_session_message")
		}
		var parts []struct {
			Type, Text string
			SessionID  string `json:"sessionID"`
			MessageID  string `json:"messageID"`
		}
		if json.Unmarshal(m.Parts, &parts) != nil {
			return nil, false, errors.New("invalid_messages")
		}
		for _, p := range parts {
			if p.SessionID != session || p.MessageID != info.ID {
				return nil, false, errors.New("foreign_message_part")
			}
		}
		if info.Role == "assistant" {
			last = i
		}
		payload.Messages = append(payload.Messages, struct {
			Info struct {
				ID, Role, Agent, Finish string
				SessionID               string          `json:"sessionID"`
				ProviderID              string          `json:"providerID"`
				ModelID                 string          `json:"modelID"`
				Error                   json.RawMessage `json:"error"`
				Time                    struct {
					Completed int64 `json:"completed"`
				} `json:"time"`
			}
			Parts []struct {
				Type, Text string
				SessionID  string `json:"sessionID"`
				MessageID  string `json:"messageID"`
			}
		}{info, parts})
	}
	if last < 0 {
		return nil, false, nil
	}
	m := payload.Messages[last]
	if len(m.Info.Error) > 0 && string(m.Info.Error) != "null" {
		return nil, false, errors.New("runtime_model_error")
	}
	if m.Info.Time.Completed <= 0 || m.Info.Finish == "" || m.Info.Finish == "tool-calls" || m.Info.Finish == "unknown" {
		return nil, false, nil
	}
	// finish='length' is accepted alongside 'stop': a chatty model can hit
	// the output cap, and the strict ParseAssistantResult below already
	// rejects a truncated JSON — accepting the finish reason only lets a
	// complete-but-capped object through, never a partial one.
	if (m.Info.Finish != "stop" && m.Info.Finish != "length") || m.Info.Agent != "assistant" || m.Info.ProviderID != "bridge" || m.Info.ModelID != model {
		log.Printf("assistant terminal rejected: finish=%q agent=%q provider=%q model=%q (want stop|length/assistant/bridge/%s)", m.Info.Finish, m.Info.Agent, m.Info.ProviderID, m.Info.ModelID, model)
		return nil, false, errors.New("invalid_terminal_message")
	}
	var texts []string
	for _, p := range m.Parts {
		if p.Type == "text" {
			texts = append(texts, p.Text)
		}
	}
	if len(texts) != 1 || len(texts[0]) > agent.MaxResponseBytes {
		// deepseek sometimes streams its whole answer into the reasoning
		// part and finishes with an empty message text (parts=[step-start
		// reasoning step-finish]). Fall back to the newest reasoning text
		// ONLY as a parse candidate: the strict AssistantResult gate below
		// still decides — prose thoughts never pass as an answer.
		if len(texts) == 0 && m.Info.Finish == "stop" {
			for i := len(m.Parts) - 1; i >= 0; i-- {
				if m.Parts[i].Type == "reasoning" && m.Parts[i].Text != "" {
					texts = append(texts, m.Parts[i].Text)
					log.Printf("assistant terminal: empty text, trying reasoning tail (%d chars)", len(m.Parts[i].Text))
					break
				}
			}
		}
	}
	if len(texts) != 1 || len(texts[0]) > agent.MaxResponseBytes {
		size := -1
		if len(texts) == 1 {
			size = len(texts[0])
		}
		var partTypes []string
		for _, p := range m.Parts {
			partTypes = append(partTypes, p.Type)
		}
		log.Printf("assistant terminal rejected: text parts=%d len=%d all_part_types=%v", len(texts), size, partTypes)
		return nil, false, errors.New("invalid_terminal_result")
	}
	var result agent.AssistantResult
	result, err := agent.ParseAssistantResult([]byte(texts[0]))
	if err != nil {
		// Diagnostics: the strict contract rejection is invisible to the
		// operator; log the terminal text tail (where actions live) so
		// drift (markdown fences, prose, truncation) can be fixed in the
		// prompt instead of guessed.
		tail := texts[0]
		if len(tail) > 1200 {
			tail = tail[len(tail)-1200:]
		}
		log.Printf("assistant terminal parse failed (%v); text tail: %s", err, tail)
		return nil, false, err
	}
	return &result, true, nil
}
