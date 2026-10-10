package opencode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const modelRequestLimit = 512 << 10
const modelResponseLimit = 2 << 20

type ModelProxyConfig struct {
	BaseURL, APIKey, ModelName string
	HTTPClient                 *http.Client
	ModelTimeout               time.Duration
}

// NewModelProxy keeps vendor credentials and actual-send accounting outside the runtime.
func NewModelProxy(b *Bridge, cfg ModelProxyConfig) http.Handler {
	if cfg.ModelTimeout <= 0 {
		cfg.ModelTimeout = 30 * time.Second
	}
	client := &http.Client{}
	if cfg.HTTPClient != nil {
		copy := *cfg.HTTPClient
		client = &copy
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	upstream, configErr := url.Parse(strings.TrimRight(cfg.BaseURL, "/") + "/chat/completions")
	if configErr == nil && (upstream.Host == "" || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "") {
		configErr = errors.New("invalid upstream")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail := func(code int, kind string) { proxyError(w, code, kind) }
		if r.URL.Path != "/v1/chat/completions" || r.URL.RawQuery != "" {
			fail(404, "route_denied")
			return
		}
		if r.Method != http.MethodPost {
			fail(405, "method_denied")
			return
		}
		grant, ok := b.authorizeGrant(r)
		if !ok {
			fail(401, "grant_denied")
			return
		}
		if configErr != nil || cfg.APIKey == "" || cfg.ModelName == "" || grant.Model != cfg.ModelName {
			fail(503, "model_unavailable")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, modelRequestLimit+1))
		if err != nil || len(raw) > modelRequestLimit {
			fail(413, "request_too_large")
			return
		}
		body, stream, err := validateModelBody(raw, grant)
		if err != nil {
			// Diagnostics: the 400 is opaque to the runtime, so log the
			// precise reason and a truncated body once per rejection.
			log.Printf("model_proxy rejected request (grant model=%s): %v; body: %.600s", grant.Model, err, raw)
			fail(400, "invalid_model_request")
			return
		}
		// Diagnostics: confirm what tool surface the model actually saw.
		// A missing/empty tools array localizes "assistant ignores data
		// questions" to the runtime's MCP plumbing rather than the model.
		if messages, ok := body["messages"].([]any); ok {
			toolNames := []string{}
			if tools, ok := body["tools"].([]any); ok {
				for _, t := range tools {
					if m, ok := t.(map[string]any); ok {
						if fn, ok := m["function"].(map[string]any); ok {
							if name, ok := fn["name"].(string); ok {
								toolNames = append(toolNames, name)
							}
						} else if name, ok := m["name"].(string); ok {
							toolNames = append(toolNames, name)
						}
					}
				}
			}
			toolCalls := 0
			for _, m := range messages {
				if msg, ok := m.(map[string]any); ok {
					if _, exists := msg["tool_calls"]; exists {
						toolCalls++
					}
				}
			}
			log.Printf("model_proxy call: msgs=%d tools=%d [%s] tool_call_msgs=%d", len(messages), len(toolNames), strings.Join(toolNames, ","), toolCalls)
		}
		outgoing, err := canonicalJSON(body)
		if err != nil || len(outgoing) > modelRequestLimit {
			fail(413, "request_too_large")
			return
		}
		digest, err := canonicalHash(body)
		if err != nil {
			fail(400, "invalid_model_request")
			return
		}
		callID := uuid.NewString()
		params := map[string]any{"call_id": callID, "request_digest": digest, "model": grant.Model, "policy_version": grant.PolicyVersion, "phase": "started"}
		deadline := time.Now().Add(cfg.ModelTimeout)
		if grant.ExpiresAt.Before(deadline) {
			deadline = grant.ExpiresAt
		}
		ctx, cancel := context.WithDeadline(r.Context(), deadline)
		defer cancel()
		entry, active := b.activeEntry(grant)
		if !active {
			fail(401, "grant_denied")
			return
		}
		stop := context.AfterFunc(entry.ctx, cancel)
		defer stop()
		admitted, err := b.postData(ctx, grant, "model_call", params)
		if err != nil || admitted["ok"] != true || admitted["disposition"] != "send_once" {
			fail(409, "model_admission_unavailable")
			return
		}
		terminal := func(phase string, usage map[string]int64) bool {
			receipt := map[string]any{"call_id": callID, "request_digest": digest, "model": grant.Model, "policy_version": grant.PolicyVersion, "phase": phase}
			if usage != nil {
				receipt["input_tokens"] = usage["prompt_tokens"]
				receipt["output_tokens"] = usage["completion_tokens"]
			}
			// Cancellation is not proof of zero cost. Finish the receipt independently, within the grant's absolute deadline.
			until := time.Now().Add(2 * time.Second)
			if grant.ExpiresAt.Before(until) {
				until = grant.ExpiresAt
			}
			receiptCtx, done := context.WithDeadline(context.Background(), until)
			defer done()
			ack, e := b.postData(receiptCtx, grant, "model_call", receipt)
			return e == nil && ack["ok"] == true && ack["disposition"] == phase
		}
		unknown := func() { terminal("unknown", nil); fail(502, "model_outcome_unknown") }
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream.String(), bytes.NewReader(outgoing))
		if err != nil {
			unknown()
			return
		}
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			unknown()
			return
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			unknown()
			return
		}
		if stream {
			if !strings.HasPrefix(strings.ToLower(res.Header.Get("Content-Type")), "text/event-stream") {
				unknown()
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-store")
			usage, e := relayModelStream(w, res.Body, grant.MaxOutputTokensPerCall)
			if e != nil || !terminal("completed", usage) {
				terminal("unknown", nil)
				io.WriteString(w, "event: error\ndata: {\"error\":{\"code\":\"model_outcome_unknown\"}}\n\n")
			} else {
				io.WriteString(w, "data: [DONE]\n\n")
			}
			if flush, ok := w.(http.Flusher); ok {
				flush.Flush()
			}
			return
		}
		output, err := io.ReadAll(io.LimitReader(res.Body, modelResponseLimit+1))
		if err != nil || len(output) > modelResponseLimit || !utf8.Valid(output) {
			unknown()
			return
		}
		var decoded map[string]json.RawMessage
		if json.Unmarshal(output, &decoded) != nil {
			unknown()
			return
		}
		usage, err := modelUsage(decoded["usage"], grant.MaxOutputTokensPerCall)
		if err != nil || !terminal("completed", usage) {
			unknown()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(output)
	})
}

func proxyError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code}})
}

func validateModelBody(raw []byte, g Grant) (map[string]any, bool, error) {
	invalid := errors.New("invalid model body")
	if !utf8.Valid(raw) {
		return nil, false, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var body map[string]any
	if decoder.Decode(&body) != nil || body == nil || decoder.Decode(new(any)) != io.EOF {
		return nil, false, invalid
	}
	allowed := map[string]bool{"model": true, "messages": true, "max_tokens": true, "stream": true, "stream_options": true, "tools": true, "tool_choice": true, "response_format": true, "temperature": true, "top_p": true, "stop": true}
	for key := range body {
		if !allowed[key] {
			return nil, false, invalid
		}
	}
	if body["model"] != g.Model || g.MaxOutputTokensPerCall < 1 {
		return nil, false, invalid
	}
	if tokens, exists := body["max_tokens"]; exists {
		n, ok := tokens.(json.Number)
		v, e := n.Int64()
		if !ok || e != nil || v < 1 || v > int64(g.MaxOutputTokensPerCall) {
			return nil, false, invalid
		}
	} else {
		body["max_tokens"] = g.MaxOutputTokensPerCall
	}
	messages, ok := body["messages"].([]any)
	if !ok || len(messages) == 0 || len(messages) > 512 {
		return nil, false, invalid
	}
	for _, value := range messages {
		msg, ok := value.(map[string]any)
		if !ok {
			return nil, false, invalid
		}
		role, ok := msg["role"].(string)
		if !ok || (role != "system" && role != "user" && role != "assistant" && role != "tool") {
			return nil, false, invalid
		}
		for key := range msg {
			// reasoning_content is a vendor extension (deepseek et al.) that
			// opencode echoes back on follow-up turns of the same session;
			// dropping it is safe — it never carries tool/answer content.
			if key == "reasoning_content" {
				delete(msg, key)
				continue
			}
			if key != "role" && key != "content" && key != "tool_calls" && key != "tool_call_id" {
				return nil, false, invalid
			}
		}
		if content, exists := msg["content"]; exists && content != nil {
			if _, ok := content.(string); !ok {
				return nil, false, invalid
			}
		}
	}
	stream := false
	if value, exists := body["stream"]; exists {
		stream, ok = value.(bool)
		if !ok {
			return nil, false, invalid
		}
	}
	if options, exists := body["stream_options"]; exists {
		m, ok := options.(map[string]any)
		if !ok || len(m) > 1 {
			return nil, false, invalid
		}
		if v, exists := m["include_usage"]; exists {
			if _, ok := v.(bool); !ok {
				return nil, false, invalid
			}
		}
	}
	if stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	} else {
		delete(body, "stream_options")
	}
	for _, key := range []string{"temperature", "top_p"} {
		if value, exists := body[key]; exists {
			n, ok := value.(json.Number)
			v, e := n.Float64()
			max := 2.0
			if key == "top_p" {
				max = 1
			}
			if !ok || e != nil || v < 0 || v > max {
				return nil, false, invalid
			}
		}
	}
	return body, stream, nil
}

func modelUsage(raw json.RawMessage, max int) (map[string]int64, error) {
	var usage map[string]json.RawMessage
	if json.Unmarshal(raw, &usage) != nil || usage == nil {
		return nil, errors.New("missing usage")
	}
	counts := map[string]int64{}
	for _, key := range []string{"prompt_tokens", "completion_tokens"} {
		var value int64
		if json.Unmarshal(usage[key], &value) != nil || value < 0 || value > 1<<53-1 {
			return nil, errors.New("invalid usage")
		}
		counts[key] = value
	}
	if counts["completion_tokens"] > int64(max) {
		return nil, errors.New("output limit exceeded")
	}
	if total, exists := usage["total_tokens"]; exists {
		var n int64
		if json.Unmarshal(total, &n) != nil || n != counts["prompt_tokens"]+counts["completion_tokens"] {
			return nil, errors.New("invalid total usage")
		}
	}
	return counts, nil
}

func relayModelStream(w http.ResponseWriter, body io.Reader, max int) (map[string]int64, error) {
	bounded := &io.LimitedReader{R: body, N: modelResponseLimit + 1}
	scanner := bufio.NewScanner(bounded)
	scanner.Buffer(make([]byte, 4096), modelResponseLimit+1)
	size := 0
	var frame []string
	var usage map[string]int64
	done := false
	process := func() error {
		if len(frame) == 0 {
			return nil
		}
		var data []string
		for _, line := range frame {
			if strings.HasPrefix(line, "data:") {
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		payload := strings.Join(data, "\n")
		if payload == "[DONE]" {
			done = true
			frame = nil
			return nil
		}
		if done {
			return errors.New("data after done")
		}
		if payload != "" {
			var chunk map[string]json.RawMessage
			if !utf8.ValidString(payload) || json.Unmarshal([]byte(payload), &chunk) != nil || chunk["error"] != nil {
				return errors.New("invalid stream")
			}
			if raw, exists := chunk["usage"]; exists && string(raw) != "null" {
				if usage != nil {
					return errors.New("duplicate usage")
				}
				var err error
				usage, err = modelUsage(raw, max)
				if err != nil {
					return err
				}
			}
		}
		_, err := io.WriteString(w, strings.Join(frame, "\n")+"\n\n")
		if err != nil {
			return err
		}
		if flush, ok := w.(http.Flusher); ok {
			flush.Flush()
		}
		frame = nil
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		size += len(line) + 1
		if size > modelResponseLimit {
			return nil, errors.New("response too large")
		}
		if line == "" {
			if err := process(); err != nil {
				return nil, err
			}
		} else {
			frame = append(frame, line)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if bounded.N <= 0 {
		return nil, errors.New("response too large")
	}
	if len(frame) > 0 {
		return nil, errors.New("incomplete event")
	}
	if !done || usage == nil {
		return nil, errors.New("incomplete stream")
	}
	return usage, nil
}
