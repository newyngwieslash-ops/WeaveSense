package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
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
			Result:  &AgentResult{Content: strPtr("ok"), Citations: []EvidenceCitation{}, Coverage: CoveragePartial, Warnings: []string{}},
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

func governedWorkerFixture(t *testing.T, phase string) (Config, map[string]any) {
	t.Helper()
	cfg := Config{SkillsDir: t.TempDir(), DataToken: "service"}
	writeSkill(t, cfg.SkillsDir, "cross-source-check", "---\nname: cross-source-check\ndescription: d\n---\n\nrule")
	ctx, err := withSkillSnapshot(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	claim := map[string]any{"job_id": "job", "run_id": "00000000-0000-4000-8000-000000000001", "claim_token": "claim", "data_access_token": "grant", "mode": "research", "governed": true, "phase": phase, "producer_model_calls": 2, "producer_deadline_at": time.Now().Add(20 * time.Second).UTC().Format(time.RFC3339), "skill_snapshot_digest": skillSnapshotDigest(ctx), "input": map[string]any{"question": "q"}, "policy": Policy{Version: "loom-agent-v1", DeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339), MaxModelCalls: 3, MaxToolCalls: 1, MaxOutputTokensPerCall: 1800}}
	return cfg, claim
}

func TestGovernedWorkerStagesAndExactAckRetries(t *testing.T) {
	for _, phase := range []string{"producer", "review", "finalize"} {
		t.Run(phase, func(t *testing.T) {
			cfg, claim := governedWorkerFixture(t, phase)
			var actions []string
			counts := map[string]int{}
			bodies := map[string]string{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				action, _ := body["action"].(string)
				if action == "claim" {
					_ = json.NewEncoder(w).Encode(claim)
					return
				}
				if action == "renew" {
					_, _ = w.Write([]byte(`{"ok":true}`))
					return
				}
				counts[action]++
				if counts[action] == 1 {
					actions = append(actions, action)
					bodies[action] = string(raw)
					w.WriteHeader(503)
					return
				}
				if bodies[action] != string(raw) {
					t.Errorf("retry changed %s body", action)
				}
				if action == "complete" {
					t.Error("governed success used legacy complete")
				}
				if action == "finalize" {
					if _, ok := body["status"]; ok {
						t.Error("worker chose final status")
					}
					if _, ok := body["response"]; ok {
						t.Error("worker republished response")
					}
				}
				if action == "review_start" {
					_, _ = w.Write([]byte(`{"ok":true,"skip":true}`))
					return
				}
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			cfg.DataURL = srv.URL + "/agent-data"
			calls := 0
			err := RunWorkerOnce(context.Background(), cfg, func(ctx context.Context, req ExecuteRequest) (ExecuteResponse, error) {
				calls++
				if !isGovernedExecution(ctx) || req.Policy.MaxModelCalls != 2 || skillSnapshotDigest(ctx) != claim["skill_snapshot_digest"] {
					t.Error("producer claim constraints not bound")
				}
				deadline, _ := ctx.Deadline()
				want, _ := time.Parse(time.RFC3339, claim["producer_deadline_at"].(string))
				if !deadline.Equal(want) {
					t.Error("producer deadline not reserved")
				}
				return ExecuteResponse{SchemaVersion: 1, RunID: req.RunID, OK: true, Result: &AgentResult{Content: strPtr("candidate")}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"finalize"}
			wantCalls := 0
			if phase == "producer" {
				want = []string{"candidate", "review_start", "finalize"}
				wantCalls = 1
			}
			if phase == "review" {
				want = []string{"review_start", "finalize"}
			}
			if calls != wantCalls || !reflect.DeepEqual(actions, want) {
				t.Fatalf("calls=%d actions=%v want %v", calls, actions, want)
			}
		})
	}
}

func TestGovernedWorkerSkillDigestRejectsBeforeProducer(t *testing.T) {
	for _, digest := range []string{"", strings.Repeat("a", 64)} {
		t.Run(digest, func(t *testing.T) {
			cfg, claim := governedWorkerFixture(t, "producer")
			claim["skill_snapshot_digest"] = digest
			var code string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["action"] == "claim" {
					_ = json.NewEncoder(w).Encode(claim)
					return
				}
				code, _ = body["error_code"].(string)
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			cfg.DataURL = srv.URL + "/agent-data"
			calls := 0
			err := RunWorkerOnce(context.Background(), cfg, func(context.Context, ExecuteRequest) (ExecuteResponse, error) { calls++; return ExecuteResponse{}, nil })
			if err != nil || calls != 0 || code != "skill_snapshot_mismatch" {
				t.Fatalf("calls=%d code=%s err=%v", calls, code, err)
			}
		})
	}
}

func TestGovernedWorkerReviewKeepsLeaseAndAcknowledgesCancellation(t *testing.T) {
	for _, scenario := range []string{"slow_review", "cancel_review", "cancel_producer", "lost_lease"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			cfg, claim := governedWorkerFixture(t, "review")
			if scenario == "cancel_producer" {
				claim["phase"] = "producer"
			}
			reviewReq := reviewFixture(t)
			report, _ := json.Marshal(reviewReportFixture(reviewReq))
			var renewals, models, producers atomic.Int32
			var mu sync.Mutex
			counts := map[string]int{}
			var errorCode string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if r.URL.Path == "/agent-jobs" {
					action, _ := body["action"].(string)
					mu.Lock()
					counts[action]++
					attempt := counts[action]
					mu.Unlock()
					switch action {
					case "claim":
						_ = json.NewEncoder(w).Encode(claim)
					case "renew":
						renewals.Add(1)
						if scenario == "lost_lease" {
							w.WriteHeader(409)
							return
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "cancel_requested": scenario == "cancel_review" || scenario == "cancel_producer"})
					case "review_start":
						_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "request": reviewReq})
					case "review_result":
						if attempt == 1 {
							w.WriteHeader(503)
							return
						}
						_, _ = w.Write([]byte(`{"ok":true}`))
					case "review_error":
						errorCode, _ = body["error_code"].(string)
						if body["outcome_unknown"] != true {
							t.Error("cancelled active review must be unknown")
						}
						_, _ = w.Write([]byte(`{"ok":true}`))
					case "finalize":
						_, _ = w.Write([]byte(`{"ok":true}`))
					case "complete":
						errorCode, _ = body["error_code"].(string)
						if body["status"] != "outcome_unknown" {
							t.Error("cancelled producer must report unknown")
						}
						_, _ = w.Write([]byte(`{"ok":true}`))
					default:
						t.Errorf("unexpected action %s", action)
						w.WriteHeader(400)
					}
					return
				}
				if r.URL.Path == "/agent-review" {
					params, _ := body["params"].(map[string]any)
					phase, _ := params["phase"].(string)
					if phase == "started" {
						phase = "send_once"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "disposition": phase})
					return
				}
				models.Add(1)
				delay := 9 * time.Second
				if scenario != "slow_review" {
					delay = 15 * time.Second
				}
				timer := time.NewTimer(delay)
				defer timer.Stop()
				select {
				case <-r.Context().Done():
					return
				case <-timer.C:
				}
				_, _ = w.Write(openaiReply(string(report)))
			}))
			defer srv.Close()
			cfg.DataURL = srv.URL + "/agent-data"
			cfg.ServiceToken = "service"
			cfg.ModelBaseURL = srv.URL
			cfg.ModelAPIKey = "fake"
			cfg.ModelName = "compat-model"
			ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
			defer cancel()
			err := RunWorkerOnce(ctx, cfg, func(execCtx context.Context, _ ExecuteRequest) (ExecuteResponse, error) {
				producers.Add(1)
				if scenario == "cancel_producer" {
					<-execCtx.Done()
					return ExecuteResponse{}, execCtx.Err()
				}
				return ExecuteResponse{}, nil
			})
			if scenario == "cancel_producer" {
				mu.Lock()
				defer mu.Unlock()
				if err != nil || producers.Load() != 1 || models.Load() != 0 || counts["complete"] != 1 || counts["finalize"] != 0 || errorCode != "cancelled" {
					t.Fatalf("producer cancel counts=%v models=%d code=%s err=%v", counts, models.Load(), errorCode, err)
				}
				return
			}
			if producers.Load() != 0 || models.Load() != 1 || renewals.Load() < 1 {
				t.Fatalf("producer=%d model=%d renew=%d err=%v", producers.Load(), models.Load(), renewals.Load(), err)
			}
			mu.Lock()
			defer mu.Unlock()
			if scenario == "lost_lease" {
				if err == nil || counts["review_error"] != 0 || counts["finalize"] != 0 {
					t.Fatalf("stale lease reported: %v err=%v", counts, err)
				}
				return
			}
			if err != nil || counts["finalize"] != 1 {
				t.Fatalf("counts=%v err=%v", counts, err)
			}
			if scenario == "slow_review" {
				if counts["review_result"] != 2 || counts["review_error"] != 0 {
					t.Fatalf("review not saved with ACK retry: %v", counts)
				}
			} else if errorCode != "cancelled" || counts["review_error"] != 1 {
				t.Fatalf("cancellation not acknowledged: %v code=%s", counts, errorCode)
			}
		})
	}
}

func TestGovernedWorkerCandidateRetryStopsAtDeadline(t *testing.T) {
	cfg, claim := governedWorkerFixture(t, "producer")
	var candidates atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["action"] == "claim" {
			_ = json.NewEncoder(w).Encode(claim)
			return
		}
		if body["action"] == "candidate" {
			candidates.Add(1)
		}
		w.WriteHeader(503)
	}))
	defer srv.Close()
	cfg.DataURL = srv.URL + "/agent-data"
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	calls := 0
	err := RunWorkerOnce(ctx, cfg, func(context.Context, ExecuteRequest) (ExecuteResponse, error) {
		calls++
		return ExecuteResponse{SchemaVersion: 1, RunID: claim["run_id"].(string), OK: true}, nil
	})
	if err == nil || calls != 1 || candidates.Load() < 2 {
		t.Fatalf("retry counts producer=%d candidate=%d err=%v", calls, candidates.Load(), err)
	}
}
