package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func fixtureDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "validation", "agent", "contracts")
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestContractValidFixtures(t *testing.T) {
	for _, name := range []string{"analyze-valid.json", "briefing-valid.json", "research-valid.json"} {
		var fixture struct {
			Request  json.RawMessage `json:"request"`
			Response json.RawMessage `json:"response"`
		}
		if err := json.Unmarshal(readFixture(t, name), &fixture); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		req, err := ParseExecuteRequest(fixture.Request)
		if err != nil {
			t.Fatalf("%s request: %v", name, err)
		}
		if _, err := ParseExecuteResponse(fixture.Response, req.Mode); err != nil {
			t.Fatalf("%s response: %v", name, err)
		}
	}
}

func TestResponseEmptyEvidenceRemainsAnArray(t *testing.T) {
	for _, response := range []ExecuteResponse{
		{OK: true, Evidence: []Evidence{}},
		{OK: false},
	} {
		data, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		if response.OK && string(fields["evidence"]) != "[]" {
			t.Fatalf("successful response must preserve the empty evidence array: %s", data)
		}
		if !response.OK && fields["evidence"] != nil {
			t.Fatalf("error response must not acquire evidence outside its schema: %s", data)
		}
	}
}

func TestContractInvalidFixtures(t *testing.T) {
	var cases []struct {
		ID      string          `json:"id"`
		Kind    string          `json:"kind"`
		Mode    string          `json:"mode"`
		Payload json.RawMessage `json:"payload"`
		Raw     string          `json:"raw"`
	}
	if err := json.Unmarshal(readFixture(t, "invalid-cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		var err error
		switch item.Kind {
		case "analysis":
			_, err = ParseAnalysis(item.Payload)
		case "request":
			_, err = ParseExecuteRequest(item.Payload)
		case "response":
			mode := Mode(item.Mode)
			if mode == "" {
				mode = ModeAnalyzeItem
			}
			_, err = ParseExecuteResponse(item.Payload, mode)
		case "raw_response":
			_, err = ParseExecuteResponse([]byte(item.Raw), ModeAnalyzeItem)
		default:
			t.Fatalf("unknown kind %s", item.Kind)
		}
		if err == nil {
			t.Fatalf("expected reject %s", item.ID)
		}
	}
}

func TestContractAnalysisRejectsStringTopics(t *testing.T) {
	_, err := ParseAnalysis([]byte(`{"summary":"摘要","topics":"主题","entities":[],"insights":"洞察","tags":[]}`))
	if err == nil {
		t.Fatal("expected reject")
	}
}

// Models emit explicit null for empty collections; the host zod schema
// requires arrays. ParseAssistantResult normalizes nil to empty.
func TestParseAssistantResultNormalizesNullCollections(t *testing.T) {
	result, err := ParseAssistantResult([]byte(`{"version":1,"answer":"ok","citations":[],"actions":null,"clarification":{"question":"下一步?","options":["a","b"]}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if result.Actions == nil || len(result.Actions) != 0 {
		t.Fatalf("actions not normalized: %v", result.Actions)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(out, []byte(`"actions":[]`)) {
		t.Fatalf("re-marshaled payload missing empty actions: %s", out)
	}
}
