package opencode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestClientLockedContractAndTrustBoundaries(t *testing.T) {
	raw, err := os.ReadFile("../../../../validation/agent/opencode/runtime-lock.json")
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Version string `json:"version"`
		OpenAPI string `json:"openapi_sha256"`
	}
	_ = json.Unmarshal(raw, &lock)
	if lock.Version != RuntimeVersion || lock.OpenAPI != OpenAPIDigest {
		t.Fatal("contract pin changed without client verification")
	}
	spec, err := os.ReadFile("../../../../validation/agent/opencode/openapi.snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, spec); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(compact.Bytes())
	if hex.EncodeToString(sum[:]) != OpenAPIDigest {
		t.Fatal("locked OpenAPI differs from client pin")
	}
	for _, tc := range []struct {
		name          string
		status        int
		body, content string
	}{
		{"unauthorized", 401, `{}`, "application/json"}, {"version", 200, `{"healthy":true,"version":"9"}`, "application/json"},
		{"non-json", 200, `<html>`, "text/html"}, {"oversize", 200, strings.Repeat("x", MaxRuntimeBytes+1), "application/json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.content)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer s.Close()
			c, _ := NewClient(s.URL, "test-control-token", nil)
			if c.Health(context.Background()) == nil {
				t.Fatal("unsafe response accepted")
			}
		})
	}
	c, _ := NewClient("http://runtime:4097", "test-control-token", nil)
	if _, _, err := c.Forward(context.Background(), Binding{}, "GET", "/session/ses_foreign/message", nil); err == nil {
		t.Fatal("unbound route accepted")
	}
}

func TestTerminalRequiresOwnCompletedAssistantStrictResult(t *testing.T) {
	result := `{"content":"report","citations":[],"coverage":"partial","insufficient_evidence":true,"warnings":[]}`
	message := func(session, finish, text string, completed int) []byte {
		raw, _ := json.Marshal([]any{map[string]any{"info": map[string]any{"id": "msg_A", "sessionID": session, "role": "assistant", "agent": "research", "providerID": "bridge", "modelID": "model", "finish": finish, "time": map[string]int{"completed": completed}}, "parts": []any{map[string]any{"type": "text", "text": text, "sessionID": session, "messageID": "msg_A"}}}})
		return raw
	}
	for _, tc := range []struct {
		name, session, finish, text string
		completed                   int
		wantErr, wantReady          bool
	}{
		{"foreign", "ses_other", "stop", result, 1, true, false}, {"unfinished", "ses_A", "", result, 0, false, false},
		{"tool-turn", "ses_A", "tool-calls", result, 1, false, false}, {"plain-text", "ses_A", "stop", "done", 1, true, false},
		{"extra-field", "ses_A", "stop", strings.TrimSuffix(result, "}") + `,"tool":"bash"}`, 1, true, false},
		{"missing-fields", "ses_A", "stop", `{"content":"report","coverage":"partial"}`, 1, true, false},
		{"valid", "ses_A", "stop", result, 1, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ready, err := TerminalResult(message(tc.session, tc.finish, tc.text, tc.completed), "ses_A", "model")
			if (err != nil) != tc.wantErr || ready != tc.wantReady {
				t.Fatalf("ready %v err %v", ready, err)
			}
		})
	}
}

func TestEventsAreObservationOnlyAndDeduplicate(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_A\"}}\n\ndata: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_A\"}}\n\n"))
	}))
	defer s.Close()
	c, _ := NewClient(s.URL, "test-control-token", nil)
	count := 0
	err := c.Observe(context.Background(), Binding{InstanceID: "00000000-0000-4000-8000-000000000001", Epoch: "00000000-0000-4000-8000-000000000002", SessionID: "ses_A"}, func(json.RawMessage) { count++ })
	if err == nil || count != 1 {
		t.Fatalf("disconnect must surface; count %d err %v", count, err)
	}
}

func TestStopRequiresExplicitProcessConfirmation(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"instance_id":"00000000-0000-4000-8000-000000000001","epoch":"00000000-0000-4000-8000-000000000002","version":"1.3.13","status":"stopped","process_running":true,"stopped":true}`))
	}))
	defer s.Close()
	c, _ := NewClient(s.URL, "test-control-token", nil)
	if c.Stop(context.Background(), Binding{InstanceID: "00000000-0000-4000-8000-000000000001", Epoch: "00000000-0000-4000-8000-000000000002"}) == nil {
		t.Fatal("live process reported stopped")
	}
}

func TestRedirectCannotReceiveRuntimeCredential(t *testing.T) {
	visited := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { visited = true; w.WriteHeader(200) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	c, _ := NewClient(source.URL, "test-control-token", nil)
	if c.Health(context.Background()) == nil || visited {
		t.Fatal("redirect leaked runtime credential")
	}
}
