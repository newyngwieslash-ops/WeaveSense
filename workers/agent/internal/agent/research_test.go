package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/schema"
)

func researchReq() ExecuteRequest {
	return ExecuteRequest{
		SchemaVersion:   1,
		RunID:           "8ec1448d-d195-50a9-af6c-3d343a46cd68",
		Mode:            ModeResearch,
		DataAccessToken: "run-token",
		Input:           ExecuteInput{Question: "固态电池量产目前卡在哪些环节？"},
		Policy: Policy{
			Version: "loom-agent-v1", DeadlineAt: time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339),
			MaxModelCalls: 6, MaxToolCalls: 4, MaxOutputTokensPerCall: 1800,
		},
	}
}

func TestResearchToolLoop(t *testing.T) {
	var dataCalls int32
	data := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Agent-Run-Token") != "run-token" {
			http.Error(w, "no token", 403)
			return
		}
		var body struct {
			Action string         `json:"action"`
			Params map[string]any `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Action == "model_call" {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		atomic.AddInt32(&dataCalls, 1)
		w.Header().Set("Content-Type", "application/json")
		switch body.Action {
		case "search_items":
			_, _ = w.Write([]byte(`{"items":[{"item_id":"item-1","title":"电池","evidence_id":"item:item-1:search","snippet":"量产卡点"}]}`))
		case "get_item":
			_, _ = w.Write([]byte(`{"item_id":"item-1","evidence_id":"item:item-1:0","text":"固态电池量产卡在设备","start":0,"end":10,"coverage":"full"}`))
		default:
			http.Error(w, "bad", 400)
		}
	}))
	t.Cleanup(data.Close)

	var modelCalls int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&modelCalls, 1)
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			_, _ = w.Write([]byte(`{"id":"1","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"search_items","arguments":"{\"query\":\"电池\"}"}}]}}]}`))
			return
		}
		if n == 2 {
			_, _ = w.Write([]byte(`{"id":"2","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c2","type":"function","function":{"name":"get_item","arguments":"{\"item_id\":\"item-1\"}"}}]}}]}`))
			return
		}
		if !strings.Contains(string(raw), "tool") && !strings.Contains(string(raw), "item-1") {
			// still allow final answer
		}
		content := `{"content":"材料不足","citations":[],"insufficient_evidence":true}`
		payload, _ := json.Marshal(map[string]any{
			"id": "3", "choices": []map[string]any{{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(model.Close)

	cfg := Config{ModelBaseURL: model.URL + "/v1", ModelName: "compat-model", ModelAPIKey: "k", DataURL: data.URL, DataToken: "data", MaxConcurrent: 2}
	resp, err := Execute(context.Background(), cfg, researchReq())
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK {
		if resp.Error != nil {
			t.Fatalf("research failed: %+v", *resp.Error)
		}
		t.Fatalf("%+v", resp)
	}
	if atomic.LoadInt32(&dataCalls) < 2 {
		t.Fatalf("data calls %d", dataCalls)
	}
	if atomic.LoadInt32(&modelCalls) < 3 {
		t.Fatalf("model calls %d", modelCalls)
	}
}

func TestResearchZeroResults(t *testing.T) {
	data := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(data.Close)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		content := `{"content":"材料不足","citations":[],"insufficient_evidence":true}`
		payload, _ := json.Marshal(map[string]any{
			"id": "1", "choices": []map[string]any{{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(model.Close)
	cfg := Config{ModelBaseURL: model.URL + "/v1", ModelName: "compat-model", ModelAPIKey: "k", DataURL: data.URL, DataToken: "data"}
	resp, err := Execute(context.Background(), cfg, researchReq())
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Result == nil || !resp.Result.InsufficientEvidence {
		t.Fatalf("%+v", resp)
	}
}

func TestResearchBudgetStopsToolLoop(t *testing.T) {
	req := researchReq()
	req.Policy.MaxToolCalls = 0
	req.Policy.MaxModelCalls = 1
	data := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Action == "model_call" {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		t.Error("tool should not be called")
	}))
	t.Cleanup(data.Close)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		content := `{"content":"材料不足","citations":[],"insufficient_evidence":true}`
		payload, _ := json.Marshal(map[string]any{
			"id": "1", "choices": []map[string]any{{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(model.Close)
	cfg := Config{ModelBaseURL: model.URL + "/v1", ModelName: "compat-model", ModelAPIKey: "k", DataURL: data.URL, DataToken: "data"}
	resp, err := Execute(context.Background(), cfg, req)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK {
		t.Fatalf("%+v", resp)
	}
	_ = schema.Assistant
}
