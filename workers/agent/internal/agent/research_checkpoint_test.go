package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Exercise the real interrupt/store/resume loop without external services.
func TestResearchCheckpointFinalAnswer(t *testing.T) {
	for _, durable := range []bool{false, true} {
		for _, limit := range []int{3, 6} {
			t.Run(fmt.Sprintf("durable=%v/budget=%d", durable, limit), func(t *testing.T) {
				calls, toolCalls, saves := 0, 0, 0
				var checkpoint []byte
				data := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body struct {
						Action  string `json:"action"`
						Payload []byte `json:"payload"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					w.Header().Set("Content-Type", "application/json")
					switch body.Action {
					case "save_checkpoint":
						checkpoint = body.Payload
						saves++
						fmt.Fprint(w, `{}`)
					case "get_checkpoint":
						json.NewEncoder(w).Encode(map[string]any{"found": checkpoint != nil, "payload": checkpoint})
					case "get_item":
						toolCalls++
						fmt.Fprint(w, `{"evidence_id":"item:battery","item_id":"battery","text":"yield 97%"}`)
					default:
						fmt.Fprint(w, `{}`)
					}
				}))
				defer data.Close()
				model := fakeOpenAIServer(t, func(w http.ResponseWriter, r *http.Request) {
					calls++
					message := map[string]any{"role": "assistant", "content": `{"title":"Battery","content":"yield 97%","citations":[{"evidence_id":"item:battery","quote":"yield 97%"}],"insufficient_evidence":false,"coverage":"full","warnings":[]}`}
					if calls <= 3 {
						message["content"] = ""
						message["tool_calls"] = []any{map[string]any{"id": fmt.Sprint(calls), "type": "function", "function": map[string]string{"name": "get_item", "arguments": `{"item_id":"battery"}`}}}
					}
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"id": "fake", "object": "chat.completion", "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": "stop"}}})
				})
				cfg := Config{ModelBaseURL: model.URL + "/v1", ModelAPIKey: "fake", ModelName: "fake", DataURL: data.URL + "/agent-data", DataToken: "fake"}
				req := ExecuteRequest{RunID: "checkpoint-test", Mode: ModeResearch, Policy: Policy{MaxModelCalls: limit, MaxToolCalls: 6, MaxOutputTokensPerCall: 1000}}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if durable {
					ctx = context.WithValue(ctx, workerContextKey{}, jobClaim{ClaimToken: "fake"})
				}
				result, err := runResearch(ctx, cfg, req, Coverage("full"))
				if limit == 3 {
					if err != nil || result.OK || result.Error.Code != "budget_exceeded" || calls != 3 || toolCalls != 3 {
						t.Fatalf("budget not enforced: err=%v response=%+v calls=%d tools=%d", err, result.Error, calls, toolCalls)
					}
					return
				}
				if err != nil || !result.OK {
					t.Fatalf("final answer failed: err=%v response=%+v calls=%d tools=%d saves=%d", err, result.Error, calls, toolCalls, saves)
				}
				if calls != 4 || toolCalls != 3 || (durable && saves != 4) {
					t.Fatalf("calls=%d tools=%d saves=%d", calls, toolCalls, saves)
				}
			})
		}
	}
}
