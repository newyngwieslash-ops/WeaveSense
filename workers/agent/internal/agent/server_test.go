package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func validAnalyzeJSON() []byte {
	return []byte(`{
	  "schema_version": 1,
	  "run_id": "6cb9226b-bf73-4e87-8d4a-1b121e24ab46",
	  "mode": "analyze_item",
	  "input": {
	    "question": "",
	    "sources": [{
	      "evidence_id": "item:item-1:0",
	      "item_id": "item-1",
	      "title": "示例条目",
	      "platform": "rss",
	      "source_name": "示例信源",
	      "url": "https://example.com/article",
	      "published_at": "2026-09-07T01:00:00Z",
	      "text": "用于测试的示例原文。",
	      "start": 0,
	      "end": 10,
	      "coverage": "full"
	    }],
	    "range": null
	  },
	  "policy": {
	    "version": "loom-agent-v1",
	    "deadline_at": "2099-01-01T00:00:40Z",
	    "max_model_calls": 2,
	    "max_tool_calls": 0,
	    "max_output_tokens_per_call": 1200
	  }
	}`)
}

func testConfig() Config {
	return Config{
		ListenAddr:    "127.0.0.1:0",
		ServiceToken:  "test-token",
		ModelBaseURL:  "http://127.0.0.1:9",
		ModelName:     "compat-model",
		ModelAPIKey:   "k",
		MaxConcurrent: 2,
		SkillsDir:     "",
	}
}

func TestHTTPRejectsEmptyAndWrongToken(t *testing.T) {
	srv := NewServer(testConfig(), func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		t.Fatal("execute should not run")
		return ExecuteResponse{}, nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(validAnalyzeJSON()))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("empty token status %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(validAnalyzeJSON()))
	req.Header.Set("Authorization", "Bearer wrong-token")
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token status %d", res.StatusCode)
	}
}

func TestHTTPRejectsOversizedAndMalformedJSON(t *testing.T) {
	srv := NewServer(testConfig(), func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		t.Fatal("execute should not run")
		return ExecuteResponse{}, nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	big := bytes.Repeat([]byte("a"), 512*1024+16)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(big))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge && res.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversize status %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", strings.NewReader("{not json"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed status %d", res.StatusCode)
	}
}

func TestHTTPExpiredDeadlineDoesNotExecute(t *testing.T) {
	called := false
	srv := NewServer(testConfig(), func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		called = true
		return ExecuteResponse{}, nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	body := bytes.ReplaceAll(validAnalyzeJSON(), []byte("2099-01-01T00:00:40Z"), []byte("2000-01-01T00:00:00Z"))
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if called {
		t.Fatal("expired deadline executed")
	}
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTPCapacityLimit(t *testing.T) {
	var started atomic.Int32
	release := make(chan struct{})
	srv := NewServer(testConfig(), func(ctx context.Context, _ ExecuteRequest) (ExecuteResponse, error) {
		started.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return successStub(), nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	var wg sync.WaitGroup
	statuses := make(chan int, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(validAnalyzeJSON()))
			req.Header.Set("Authorization", "Bearer test-token")
			req.Header.Set("Content-Type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			statuses <- res.StatusCode
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for started.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if started.Load() != 2 {
		close(release)
		t.Fatalf("started %d", started.Load())
	}
	close(release)
	wg.Wait()
	close(statuses)
	sawBusy := false
	for s := range statuses {
		if s == http.StatusTooManyRequests || s == http.StatusServiceUnavailable {
			sawBusy = true
		}
	}
	if !sawBusy {
		t.Fatal("expected 429 or 503 for third request")
	}
}

func TestHTTPHealthDoesNotExecute(t *testing.T) {
	called := false
	cfg := testConfig()
	cfg.SkillsDir = t.TempDir()
	for _, name := range []string{"industry-analysis", "briefing-writing", "cross-source-check"} {
		writeSkill(t, cfg.SkillsDir, name, "---\nname: "+name+"\ndescription: d\n---\n\nRequired rule.\n")
	}
	srv := NewServer(cfg, func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		called = true
		return ExecuteResponse{}, nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	for _, path := range []string{"/healthz", "/readyz"} {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s status %d", path, res.StatusCode)
		}
	}
	if called {
		t.Fatal("health executed model")
	}
}

func TestHTTPCancelPropagates(t *testing.T) {
	cancelled := make(chan struct{})
	srv := NewServer(testConfig(), func(ctx context.Context, _ ExecuteRequest) (ExecuteResponse, error) {
		<-ctx.Done()
		close(cancelled)
		return ExecuteResponse{}, ctx.Err()
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(validAnalyzeJSON()))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	_, _ = http.DefaultClient.Do(req)
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not propagate")
	}
}

func successStub() ExecuteResponse {
	summary := "摘要"
	return ExecuteResponse{
		SchemaVersion: 1,
		RunID:         "6cb9226b-bf73-4e87-8d4a-1b121e24ab46",
		OK:            true,
		Result: &AgentResult{
			Analysis:  &Analysis{Summary: summary, Topics: []string{"主题"}, Entities: []string{}, Insights: "", Tags: []string{}},
			Citations: []EvidenceCitation{},
			Coverage:  CoverageFull,
			Warnings:  []string{},
		},
		Runtime: &Runtime{
			Model: "compat-model", PromptVersion: "loom-agent-v1", SkillVersions: map[string]string{},
			Events: []RuntimeEvent{},
		},
		Evidence: []Evidence{},
	}
}

func TestHTTPSuccessRoundTrip(t *testing.T) {
	srv := NewServer(testConfig(), func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		return successStub(), nil
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/execute", bytes.NewReader(validAnalyzeJSON()))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["ok"] != true {
		t.Fatalf("%v", payload)
	}
}
