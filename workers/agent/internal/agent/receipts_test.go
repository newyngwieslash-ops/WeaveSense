package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/schema"
)

func TestGovernedProducerSendAdmission(t *testing.T) {
	for _, path := range []string{"generate", "stream", "repair"} {
		for _, disposition := range []string{"send_once", "already_started", "completed", "unknown", "legacy_ack", "receipt_error", "completion_error", "provider_error"} {
			t.Run(path+"/"+disposition, func(t *testing.T) {
				var calls atomic.Int32
				var receipts []map[string]any
				messages := []*schema.Message{schema.UserMessage("Original request <>& 中文")}
				raw, _ := json.Marshal(messages)
				wantDigest, _ := reviewJSONDigest(raw)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/agent-data" {
						var body struct {
							Params map[string]any `json:"params"`
						}
						_ = json.NewDecoder(r.Body).Decode(&body)
						receipts = append(receipts, body.Params)
						if r.Header.Get("Authorization") != "Bearer service" || r.Header.Get("X-Agent-Run-Token") != "run-grant" {
							t.Error("missing authorization")
						}
						if body.Params["request_digest"] != wantDigest {
							t.Errorf("digest=%v want %s", body.Params["request_digest"], wantDigest)
						}
						if disposition == "receipt_error" || (disposition == "completion_error" && body.Params["phase"] != "started") {
							w.WriteHeader(503)
							return
						}
						if disposition == "legacy_ack" {
							fmt.Fprint(w, `{"ok":true}`)
							return
						}
						value := disposition
						if disposition == "completion_error" || disposition == "provider_error" {
							value = "send_once"
						}
						if body.Params["phase"] != "started" {
							value = body.Params["phase"].(string)
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "disposition": value})
						return
					}
					calls.Add(1)
					if disposition == "provider_error" {
						w.WriteHeader(http.StatusUnauthorized)
						fmt.Fprint(w, `{"error":{"message":"rejected"}}`)
						return
					}
					if path == "stream" {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, "data: {\"id\":\"fake\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")
					} else {
						fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}`)
					}
				}))
				defer server.Close()
				cfg := Config{ModelBaseURL: server.URL, ModelAPIKey: "fake", ModelName: "fake", DataURL: server.URL + "/agent-data", DataToken: "service"}
				ctx, cancel := withGovernedExecution(context.Background(), time.Now().Add(time.Minute))
				defer cancel()
				ctx = context.WithValue(ctx, executionKey{}, executionReceipt{cfg: cfg, req: ExecuteRequest{RunID: "run", DataAccessToken: "run-grant"}})
				events := []RuntimeEvent{}
				inner, err := newChatModel(cfg, time.Second, 100)
				if err != nil {
					t.Fatal(err)
				}
				m := budgetModel{inner: inner, budget: &runBudget{modelLeft: 1}, events: &events}
				switch path {
				case "generate":
					_, err = m.Generate(ctx, messages)
				case "repair":
					remaining := 1
					_, err = generateOnce(ctx, cfg, &remaining, 100, &events, messages)
				case "stream":
					var stream *schema.StreamReader[*schema.Message]
					stream, err = m.Stream(ctx, messages)
					if err == nil {
						defer stream.Close()
						for {
							_, err = stream.Recv()
							if err != nil {
								break
							}
						}
						if err == io.EOF {
							err = nil
						}
					}
				}
				if disposition == "send_once" {
					if err != nil || calls.Load() != 1 || len(receipts) != 2 {
						t.Fatalf("calls=%d receipts=%d err=%v", calls.Load(), len(receipts), err)
					}
					if receipts[0]["call_id"] != receipts[1]["call_id"] {
						t.Fatal("receipt identity changed")
					}
				} else {
					wantCalls := int32(0)
					if disposition == "completion_error" || disposition == "provider_error" {
						wantCalls = 1
					}
					if err == nil || calls.Load() != wantCalls {
						t.Fatalf("calls=%d want=%d err=%v", calls.Load(), wantCalls, err)
					}
					code, retry, unknown := classifyModelError(err)
					if code != "model_outcome_unknown" || retry || !unknown {
						t.Fatalf("unsafe classification %s %v %v", code, retry, unknown)
					}
				}
			})
		}
	}
}

func TestGovernedProducerMissingConfigurationFailsClosed(t *testing.T) {
	for _, missing := range []string{"execution", "url", "service_token", "run_token", "digest"} {
		t.Run(missing, func(t *testing.T) {
			cfg := Config{DataURL: "http://127.0.0.1:1/agent-data", DataToken: "service"}
			req := ExecuteRequest{DataAccessToken: "grant"}
			if missing == "url" {
				cfg.DataURL = ""
			}
			if missing == "service_token" {
				cfg.DataToken = ""
			}
			if missing == "run_token" {
				req.DataAccessToken = ""
			}
			ctx, cancel := withGovernedExecution(context.Background(), time.Now().Add(time.Minute))
			defer cancel()
			if missing != "execution" {
				ctx = context.WithValue(ctx, executionKey{}, executionReceipt{cfg: cfg, req: req})
			}
			digest := strings.Repeat("a", 64)
			if missing == "digest" {
				digest = ""
			}
			if _, err := beforeModelCall(ctx, digest); err == nil {
				t.Fatal("missing required admission accepted")
			} else if _, retry, unknown := classifyModelError(err); retry || unknown {
				t.Fatal("missing config is definite and not retryable")
			}
		})
	}
	if _, err := beforeModelCall(context.Background()); err != nil {
		t.Fatalf("legacy changed: %v", err)
	}
}

func TestGovernedDeadlineDoesNotExtendParent(t *testing.T) {
	deadline := time.Now().Add(time.Second)
	parent, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	ctx, stop := withGovernedExecution(parent, time.Now().Add(time.Hour))
	defer stop()
	if got, _ := ctx.Deadline(); !got.Equal(deadline) {
		t.Fatal("governed stage extended parent deadline")
	}
}
