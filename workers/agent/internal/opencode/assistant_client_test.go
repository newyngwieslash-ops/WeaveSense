package opencode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Task 8: profile-aware prepare and the assistant terminal decoder (plan §4.3).

func TestPrepareProfileManifestExactness(t *testing.T) {
	cases := []struct {
		name       string
		profile    string
		body       string
		wantSkills int
		wantErr    bool
	}{
		{"research keeps three skills", "research", `{"run_id":"run-1","version":"1.3.13","config_digest":"` + d64 + `","skill_snapshot_digest":"` + d64 + `","skill_versions":{"a":"x","b":"y","c":"z"},"status":"prepared","instance_id":"00000000-0000-4000-8000-000000000001","epoch":"00000000-0000-4000-8000-000000000002"}`, 3, false},
		{"assistant requires its single skill", "assistant", `{"run_id":"run-1","version":"1.3.13","config_digest":"` + d64 + `","skill_snapshot_digest":"` + d64 + `","skill_versions":{"project-assistant":"x"},"status":"prepared","instance_id":"00000000-0000-4000-8000-000000000001","epoch":"00000000-0000-4000-8000-000000000002"}`, 1, false},
		{"assistant rejects research manifest", "assistant", `{"run_id":"run-1","version":"1.3.13","config_digest":"` + d64 + `","skill_snapshot_digest":"` + d64 + `","skill_versions":{"a":"x","b":"y","c":"z"},"status":"prepared","instance_id":"00000000-0000-4000-8000-000000000001","epoch":"00000000-0000-4000-8000-000000000002"}`, 3, true},
		{"research rejects assistant manifest", "research", `{"run_id":"run-1","version":"1.3.13","config_digest":"` + d64 + `","skill_snapshot_digest":"` + d64 + `","skill_versions":{"project-assistant":"x"},"status":"prepared","instance_id":"00000000-0000-4000-8000-000000000001","epoch":"00000000-0000-4000-8000-000000000002"}`, 1, true},
		{"unknown profile refused", "admin", `{}`, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotBody struct {
				Profile string `json:"profile"`
			}
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer s.Close()
			c, _ := NewClient(s.URL, "test-control-token", nil)
			_, err := c.PrepareProfile(context.Background(), "run-1", "grant-value-00001", "claim-value-00001", tc.profile)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err %v", err)
			}
			if tc.profile == "assistant" && gotBody.Profile != "assistant" {
				t.Fatalf("profile %q must travel with prepare", gotBody.Profile)
			}
		})
	}
}

const d64 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAssistantTerminalDecoderSeparateFromResearch(t *testing.T) {
	valid := `{"version":1,"answer":"答案","citations":[{"kind":"keyword","id":"kw1"}],"actions":[{"ordinal":0,"kind":"keyword.create","args":{"keyword":"固态电池","platforms":["rss"],"interval":30}}]}`
	researchPayload := `{"content":"report","citations":[],"coverage":"partial","insufficient_evidence":true,"warnings":[]}`
	message := func(agent, text string) []byte {
		raw, _ := json.Marshal([]any{map[string]any{"info": map[string]any{"id": "msg_A", "sessionID": "ses_A", "role": "assistant", "agent": agent, "providerID": "bridge", "modelID": "model", "finish": "stop", "time": map[string]int{"completed": 1}}, "parts": []any{map[string]any{"type": "text", "text": text, "sessionID": "ses_A", "messageID": "msg_A"}}}})
		return raw
	}
	// The assistant decoder accepts its own shape.
	answer, ready, err := AssistantTerminalResult(message("assistant", valid), "ses_A", "model")
	if err != nil || !ready || answer == nil || answer.Answer != "答案" {
		t.Fatalf("assistant decode failed: ready %v err %v", ready, err)
	}
	if len(answer.Actions) != 1 || answer.Actions[0].Kind != "keyword.create" {
		t.Fatalf("actions lost: %+v", answer)
	}
	// A research-shaped payload must NOT decode as an assistant answer.
	if _, _, err := AssistantTerminalResult(message("assistant", researchPayload), "ses_A", "model"); err == nil {
		t.Fatal("assistant decoder accepted a research payload")
	}
	// The research decoder must not accept an assistant message.
	if _, _, err := TerminalResult(message("assistant", valid), "ses_A", "model"); err == nil {
		t.Fatal("research decoder accepted an assistant message")
	}
	// Unknown fields in actions are refused.
	evil := `{"version":1,"answer":"x","citations":[],"actions":[{"ordinal":0,"kind":"keyword.create","args":{"keyword":"k","platforms":["rss"],"interval":30,"sql":"delete from keywords"}}]}`
	if _, _, err := AssistantTerminalResult(message("assistant", evil), "ses_A", "model"); err == nil {
		t.Fatal("assistant decoder accepted an unknown action field")
	}
}

// A chatty model can hit the output cap (finish='length'); if the streamed
// text still parses and validates as an AssistantResult, the turn completes.
func TestAssistantTerminalResultAcceptsLengthWithValidJSON(t *testing.T) {
	text := `{"version":1,"answer":"ok","citations":[],"actions":[]}`
	raw, _ := json.Marshal([]any{map[string]any{
		"info":  map[string]any{"id": "msg_L", "sessionID": "ses_A", "role": "assistant", "agent": "assistant", "providerID": "bridge", "modelID": "model", "finish": "length", "time": map[string]int{"completed": 1}},
		"parts": []any{map[string]any{"type": "text", "text": text, "sessionID": "ses_A", "messageID": "msg_L"}},
	}})
	result, ready, err := AssistantTerminalResult(raw, "ses_A", "model")
	if err != nil || !ready {
		t.Fatalf("length finish rejected: ready=%v err=%v", ready, err)
	}
	if result.Answer != "ok" {
		t.Fatalf("answer = %q", result.Answer)
	}
}

// AssistantProgressOf folds tool parts to their latest state and keeps the
// newest reasoning tail — the panel's live progress view.
func TestAssistantProgressOfFoldsToolStatesAndReasonTail(t *testing.T) {
	raw, _ := json.Marshal([]any{map[string]any{
		"info":  map[string]any{"sessionID": "ses_A"},
		"parts": []any{
			map[string]any{"type": "step-start"},
			map[string]any{"type": "tool", "callID": "c1", "tool": "corpus_project_overview", "state": map[string]string{"status": "running"}},
			map[string]any{"type": "reasoning", "text": "先看概览"},
			map[string]any{"type": "tool", "callID": "c1", "tool": "corpus_project_overview", "state": map[string]string{"status": "completed"}},
			map[string]any{"type": "tool", "callID": "c2", "tool": "corpus_list_keywords", "state": map[string]string{"status": "running"}},
			map[string]any{"type": "reasoning", "text": "再列关键词，注意 limit"},
		},
	}})
	progress := AssistantProgressOf(raw, "ses_A")
	if len(progress.Tools) != 2 {
		t.Fatalf("tools = %v", progress.Tools)
	}
	if progress.Tools[0].State != "completed" || progress.Tools[1].CallID != "c2" {
		t.Fatalf("fold wrong: %v", progress.Tools)
	}
	if progress.ReasonTail != "再列关键词，注意 limit" {
		t.Fatalf("reason tail = %q", progress.ReasonTail)
	}
	// Foreign session parts are ignored; malformed payloads yield zero.
	if p := AssistantProgressOf(raw, "ses_B"); len(p.Tools) != 0 || p.ReasonTail != "" {
		t.Fatalf("foreign session leaked: %v", p)
	}
	if p := AssistantProgressOf([]byte("not json"), "ses_A"); len(p.Tools) != 0 {
		t.Fatalf("malformed payload not nil-safe: %v", p)
	}
}

// deepseek sometimes streams the whole answer into the reasoning part and
// finishes with empty message text. The reasoning tail is accepted ONLY if
// it strictly parses as the AssistantResult contract.
func TestAssistantTerminalResultAcceptsReasoningOnlyWhenParseable(t *testing.T) {
	text := `{"version":1,"answer":"reasoning-only answer","citations":[],"actions":[]}`
	raw, _ := json.Marshal([]any{map[string]any{
		"info":  map[string]any{"id": "msg_R", "sessionID": "ses_A", "role": "assistant", "agent": "assistant", "providerID": "bridge", "modelID": "model", "finish": "stop", "time": map[string]int{"completed": 1}},
		"parts": []any{map[string]any{"type": "reasoning", "text": text, "sessionID": "ses_A", "messageID": "msg_R"}},
	}})
	result, ready, err := AssistantTerminalResult(raw, "ses_A", "model")
	if err != nil || !ready {
		t.Fatalf("reasoning-only rejected: ready=%v err=%v", ready, err)
	}
	if result.Answer != "reasoning-only answer" {
		t.Fatalf("answer = %q", result.Answer)
	}
	// Prose reasoning must NOT pass.
	raw2, _ := json.Marshal([]any{map[string]any{
		"info":  map[string]any{"id": "msg_R2", "sessionID": "ses_A", "role": "assistant", "agent": "assistant", "providerID": "bridge", "modelID": "model", "finish": "stop", "time": map[string]int{"completed": 1}},
		"parts": []any{map[string]any{"type": "reasoning", "text": "我在想先查概览，然后……", "sessionID": "ses_A", "messageID": "msg_R2"}},
	}})
	if _, ready, err := AssistantTerminalResult(raw2, "ses_A", "model"); ready || err == nil {
		t.Fatalf("prose reasoning accepted as answer")
	}
}
