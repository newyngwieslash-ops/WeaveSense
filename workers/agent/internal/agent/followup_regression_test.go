package agent

import (
	"context"
	"encoding/json"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/schema"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestFollowupFixedOutputAndZeroBudget(t *testing.T) {
	for _, limit := range []int{1, 0} {
		t.Run(string(rune('0'+limit)), func(t *testing.T) {
			var calls atomic.Int32
			var output atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if n, ok := body["max_tokens"].(float64); ok {
					output.Store(int32(n))
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(openaiReply(validAnalysisJSON()))
			}))
			defer srv.Close()
			req := analyzeReq()
			req.Policy.MaxModelCalls = limit
			req.Policy.MaxOutputTokensPerCall = 12
			resp, err := Execute(context.Background(), Config{ModelBaseURL: srv.URL + "/v1", ModelName: "fake", ModelAPIKey: "fake"}, req)
			t.Logf("calls=%d output_on_wire=%d requested_output=12 response_ok=%v error=%v", calls.Load(), output.Load(), resp.OK, err)
			if limit == 0 && calls.Load() != 0 {
				t.Error("zero model budget made paid call")
			}
			if limit > 0 && output.Load() > 12 {
				t.Error("fixed workflow ignored output policy")
			}
		})
	}
}

func TestFollowupSkillBudget(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "demo", "---\nname: demo\ndescription: demo\n---\n\nSKILL_SENTINEL\n")
	var calls atomic.Int32
	var loaded atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, m := range body.Messages {
			if m.Role == "tool" && len(m.Content) > 0 {
				loaded.Store(true)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			_, _ = w.Write([]byte(`{"id":"1","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"skill","arguments":"{\"skill\":\"demo\"}"}}]}}]}`))
			return
		}
		_, _ = w.Write(openaiReply(`{"content":"no evidence","citations":[],"insufficient_evidence":true}`))
	}))
	defer srv.Close()
	req := researchReq()
	req.Policy.MaxToolCalls = 0
	resp, err := Execute(context.Background(), Config{ModelBaseURL: srv.URL + "/v1", ModelName: "fake", ModelAPIKey: "fake", SkillsDir: root}, req)
	t.Logf("tool_result_received=%v reported=%+v response_ok=%v error=%v", loaded.Load(), resp.Runtime, resp.OK, err)
	if loaded.Load() {
		t.Error("skill executed with zero tool budget")
	}
}

func TestFollowupCheckpointHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "version_mismatch", 409) }))
	defer srv.Close()
	store := httpStore{cfg: Config{DataURL: srv.URL + "/agent-data", DataToken: "fake"}, runID: "fake"}
	_, found, err := store.Get(context.Background(), "checkpoint")
	t.Logf("found=%v error=%v", found, err)
	if err == nil {
		t.Error("409 converted to checkpoint absence")
	}
}

func TestFollowupAncestorSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "data.txt"), []byte("OUTSIDE"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "ref")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	data, err := (osBackend{root: root}).Read(context.Background(), &filesystem.ReadRequest{FilePath: filepath.Join(link, "data.txt")})
	if err == nil {
		t.Fatalf("read outside through ancestor symlink: %s", data.Content)
	}
}

func TestFollowupMCPRedirect(t *testing.T) {
	var leaked atomic.Bool
	dest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer FAKE_MCP_SENTINEL" {
			leaked.Store(true)
		}
		http.Error(w, "reject", 401)
	}))
	defer dest.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, dest.URL+"/mcp", 307) }))
	defer origin.Close()
	root := t.TempDir()
	config := filepath.Join(root, "mcp.json")
	t.Setenv("REVIEW_FAKE_MCP_TOKEN", "FAKE_MCP_SENTINEL")
	raw, _ := json.Marshal(map[string]any{"servers": []any{map[string]any{"id": "test", "enabled": true, "url": origin.URL + "/mcp", "transport": "streamable_http", "token_env": "REVIEW_FAKE_MCP_TOKEN", "allowed_tools": []string{"search"}, "required": true}}})
	if err := os.WriteFile(config, raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, _, err := loadMCPTools(context.Background(), Config{MCPConfigPath: config}, nil, nil)
	t.Logf("cross_origin_auth_forwarded=%v error=%v", leaked.Load(), err)
	if leaked.Load() {
		t.Error("MCP authorization forwarded to different origin")
	}
}

func TestFollowupWorkerAcknowledgement(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["action"] == "claim" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"job_id":"job","run_id":"6cb9226b-bf73-4e87-8d4a-1b121e24ab46","claim_token":"live","data_access_token":"token","mode":"research","question":"qq"}`))
			return
		}
		http.Error(w, "commit failed", 500)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := RunWorkerOnce(ctx, Config{DataURL: srv.URL + "/agent-data", DataToken: "fake"}, func(context.Context, ExecuteRequest) (ExecuteResponse, error) { return ExecuteResponse{OK: true}, nil })
	t.Logf("complete HTTP500 worker_error=%v", err)
	if err == nil {
		t.Error("failed complete acknowledgement swallowed")
	}
}

func TestFollowupStreamWire(t *testing.T) {
	var calls atomic.Int32
	var output atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if n, ok := body["max_tokens"].(float64); ok {
			output.Store(int32(n))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"id\":\"s1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"s1\",\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4,\"total_tokens\":15}}\n\ndata: [DONE]\n\n"))
	}))
	defer srv.Close()
	inner, err := newChatModel(Config{ModelBaseURL: srv.URL + "/v1", ModelName: "fake", ModelAPIKey: "fake"}, time.Second, 12)
	if err != nil {
		t.Fatal(err)
	}
	events := []RuntimeEvent{}
	b := &runBudget{modelLeft: 1}
	cm := budgetModel{inner: inner, budget: b, events: &events, name: "fake"}
	stream, err := cm.Stream(context.Background(), []*schema.Message{schema.UserMessage("hello")})
	if err != nil {
		t.Fatal(err)
	}
	for {
		_, err = stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	stream.Close()
	_, secondErr := cm.Stream(context.Background(), []*schema.Message{schema.UserMessage("again")})
	t.Logf("stream wire_calls=%d max_output=%d remaining=%d second_error=%v audit_events=%d", calls.Load(), output.Load(), b.modelLeft, secondErr, len(events))
	if calls.Load() != 1 || output.Load() != 12 || secondErr == nil {
		t.Error("stream budget failed")
	}
	if len(events) == 0 {
		t.Error("stream call not audited")
	}
}
