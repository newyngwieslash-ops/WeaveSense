package opencode

import (
	"encoding/json"
	"strings"
	"testing"
)

// The MCP SDK (1.27.1) validates tools/list entries: every inputSchema
// property must be a JSON object (AssertObjectSchema), not a string.
func TestAssistantToolSchemaPropertiesAreObjects(t *testing.T) {
	for _, name := range assistantReadToolNames {
		var schema struct {
			Type       string `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(assistantToolSchema(name), &schema); err != nil {
			t.Fatalf("%s: unmarshal: %v", name, err)
		}
		if schema.Type != "object" {
			t.Fatalf("%s: type = %q", name, schema.Type)
		}
		for key, raw := range schema.Properties {
			trimmed := strings.TrimSpace(string(raw))
			if !strings.HasPrefix(trimmed, "{") {
				t.Fatalf("%s.%s: property is not a JSON object: %s", name, key, trimmed)
			}
			var probe map[string]any
			if json.Unmarshal(raw, &probe) != nil || probe["type"] == nil {
				t.Fatalf("%s.%s: property not a schema object: %s", name, key, trimmed)
			}
		}
	}
}
