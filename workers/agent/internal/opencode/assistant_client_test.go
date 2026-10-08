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
			var gotBody struct{ Profile string `json:"profile"` }
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
