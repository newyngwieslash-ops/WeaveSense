package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkerStaleClaimCannotComplete(t *testing.T) {
	var completes atomic.Int32
	var claims atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		switch body["action"] {
		case "claim":
			if claims.Add(1) == 1 {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"job_id":"j1","run_id":"6cb9226b-bf73-4e87-8d4a-1b121e24ab46","claim_token":"old","mode":"research","question":"q1"}`))
				return
			}
			http.Error(w, "none", 404)
		case "complete":
			if body["claim_token"] != "live" {
				http.Error(w, "stale", 409)
				return
			}
			completes.Add(1)
			w.WriteHeader(200)
		default:
			http.Error(w, "no", 400)
		}
	}))
	t.Cleanup(srv.Close)
	cfg := Config{DataURL: srv.URL + "/agent-data", DataToken: "t"}
	killed := make(chan struct{})
	go func() {
		_ = RunWorkerOnce(context.Background(), cfg, func(ctx context.Context, _ ExecuteRequest) (ExecuteResponse, error) {
			<-killed
			<-ctx.Done()
			return ExecuteResponse{}, ctx.Err()
		})
	}()
	time.Sleep(20 * time.Millisecond)
	close(killed)
	time.Sleep(20 * time.Millisecond)
	if completes.Load() != 0 {
		t.Fatal("stale worker completed")
	}
}

func TestWorkerLiveClaimCanComplete(t *testing.T) {
	var completes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		switch body["action"] {
		case "claim":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"job_id":"j1","run_id":"6cb9226b-bf73-4e87-8d4a-1b121e24ab46","claim_token":"live","mode":"research","question":"q1"}`))
		case "complete":
			if body["claim_token"] == "live" && body["status"] == "succeeded" {
				completes.Add(1)
			}
			w.WriteHeader(200)
		default:
			http.Error(w, "no", 400)
		}
	}))
	t.Cleanup(srv.Close)
	cfg := Config{DataURL: srv.URL + "/agent-data", DataToken: "t"}
	err := RunWorkerOnce(context.Background(), cfg, func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		return ExecuteResponse{SchemaVersion: 1, RunID: "6cb9226b-bf73-4e87-8d4a-1b121e24ab46", OK: true,
			Result: &AgentResult{Content: strPtr("ok"), Citations: []EvidenceCitation{}, Coverage: CoveragePartial, Warnings: []string{}},
			Runtime: &Runtime{SkillVersions: map[string]string{}, Events: []RuntimeEvent{}},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if completes.Load() != 1 {
		t.Fatalf("completes %d", completes.Load())
	}
}

func strPtr(s string) *string { return &s }
