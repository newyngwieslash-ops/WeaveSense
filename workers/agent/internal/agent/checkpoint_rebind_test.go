package agent

import (
	"bytes"
	"context"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

const codecOld = "11111111-1111-4111-8111-111111111111"
const codecNew = "22222222-2222-4222-8222-222222222222"

type codecStore struct{ data []byte }

func (s *codecStore) Get(context.Context, string) ([]byte, bool, error) {
	return s.data, s.data != nil, nil
}
func (s *codecStore) Set(_ context.Context, _ string, b []byte) error {
	s.data = append([]byte(nil), b...)
	return nil
}

type codecModel struct{ calls int }

func (m *codecModel) Generate(ctx context.Context, _ []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	if interrupted, hasState, state := compose.GetInterruptState[string](ctx); interrupted && hasState {
		var message schema.Message
		if err := json.Unmarshal([]byte(state), &message); err != nil {
			return nil, err
		}
		return &message, nil
	}
	m.calls++
	message := schema.AssistantMessage("prose "+codecOld, []schema.ToolCall{{
		ID: "call-" + codecOld, Type: "function", Function: schema.FunctionCall{
			Name: "get_item", Arguments: `{"item_id":"` + codecOld + `","start":0}`,
		},
	}})
	raw, _ := json.Marshal(message)
	return nil, compose.StatefulInterrupt(ctx, "model_result_saved", string(raw))
}
func (m *codecModel) Stream(context.Context, []*schema.Message, ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	return nil, fmt.Errorf("stream not allowed")
}
func (m *codecModel) WithTools([]*schema.ToolInfo) (model.ToolCallingChatModel, error) { return m, nil }

func codecFixture(t *testing.T) (*adk.Runner, *codecStore, *codecModel, *string) {
	t.Helper()
	ctx := context.Background()
	model := &codecModel{}
	store := &codecStore{}
	seen := new(string)
	get := toolutils.NewTool(&schema.ToolInfo{Name: "get_item", Desc: "fixture",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"item_id": {Type: schema.String, Required: true}, "start": {Type: schema.Integer},
		})}, func(_ context.Context, args map[string]any) (string, error) {
		*seen, _ = args["item_id"].(string)
		return `{"item_id":"` + *seen + `","text":"prose ` + codecOld + `"}`, nil
	})
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name: "research", Description: "fixture", Model: model, MaxIterations: 4,
		ToolsConfig: adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{Tools: []tool.BaseTool{get}},
			ReturnDirectly: map[string]bool{"get_item": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent, CheckPointStore: store})
	iter := runner.Query(ctx, "original quote "+codecOld, adk.WithCheckPointID("fixture"))
	for {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			t.Fatal(event.Err)
		}
	}
	if len(store.data) == 0 || model.calls != 1 || *seen != "" {
		t.Fatal("fixture did not stop before tool")
	}
	return runner, store, model, seen
}

func TestCheckpointRebindNativeResume(t *testing.T) {
	for _, inline := range []bool{false, true} {
		t.Run(fmt.Sprintf("inline=%v", inline), func(t *testing.T) { codecNativeResume(t, inline) })
	}
}

func codecNativeResume(t *testing.T, inline bool) {
	runner, store, model, seen := codecFixture(t)
	var before rebindCheckpoint
	if err := rebindGobDecode(store.data, &before); err != nil {
		t.Fatal(err)
	}
	if before.InfoDataSourceInterruptID == "" {
		t.Fatal("fixture did not exercise native compaction")
	}
	if inline {
		before.Info.Data.(*adk.ChatModelAgentInterruptInfo).Data = before.InterruptID2State[before.InfoDataSourceInterruptID].State.([]byte)
		before.InfoDataSourceInterruptID = ""
		store.data = codecEncode(t, &before)
	}
	evidenceID := "item:" + codecOld + ":immutable:0:4"
	env := checkpointEnvelope{Schema: 1, Runtime: runtimeVersion, State: store.data, Model: "fake",
		ModelLeft: 2, ToolLeft: 4, KnownUsage: 1, UsageCalls: 1, InputTokens: 32, OutputTokens: 8,
		Evidence: []Evidence{{ItemID: stringPtr(codecOld), EvidenceID: evidenceID, Text: "quote " + codecOld, Origin: OriginInternal}},
		Events:   []RuntimeEvent{{Type: "model", Name: "fake", OK: true}}, Skills: map[string]string{"test": "hash"}}
	payload, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	rebound, err := RebindCheckpointPayload(payload, codecOld, codecNew)
	if err != nil {
		t.Fatal(err)
	}
	var after checkpointEnvelope
	if err := json.Unmarshal(rebound, &after); err != nil {
		t.Fatal(err)
	}
	if *after.Evidence[0].ItemID != codecNew || after.Evidence[0].EvidenceID != evidenceID || after.Evidence[0].Text != "quote "+codecOld {
		t.Fatal("receipt changed incorrectly")
	}
	if after.ModelLeft != env.ModelLeft || after.UsageCalls != env.UsageCalls || after.InputTokens != env.InputTokens || len(after.Events) != 1 {
		t.Fatal("budget facts lost")
	}
	expected := env
	expected.State = after.State
	expected.Evidence = append([]Evidence(nil), env.Evidence...)
	expected.Evidence[0].ItemID = stringPtr(codecNew)
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("envelope facts changed")
	}
	var decoded rebindCheckpoint
	if err := rebindGobDecode(after.State, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before.RunCtx.RootInput, decoded.RunCtx.RootInput) || !reflect.DeepEqual(before.InterruptID2Address, decoded.InterruptID2Address) || before.InfoDataSourceInterruptID != decoded.InfoDataSourceInterruptID {
		t.Fatal("history/address/compaction changed")
	}
	store.data = after.State
	iter, err := runner.Resume(context.Background(), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	for {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			t.Fatal(event.Err)
		}
	}
	if *seen != codecNew || model.calls != 1 {
		t.Fatalf("seen=%s calls=%d", *seen, model.calls)
	}
	// Explicit test-only export for the TS SQL integration; never production data.
	if output := os.Getenv("T06_CHECKPOINT_FIXTURE_PATH"); output != "" && !inline {
		fixture, err := json.MarshalIndent(map[string]any{
			"runtime": runtimeVersion, "synthetic": true, "from_item_id": codecOld, "to_item_id": codecNew,
			"before_base64": payload, "after_base64": rebound,
		}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(output, fixture, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func stringPtr(s string) *string { return &s }

func codecEncode(t *testing.T, v any) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := gob.NewEncoder(&b).Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func codecEnvelope(t *testing.T, cp *rebindCheckpoint) []byte {
	t.Helper()
	b, err := json.Marshal(checkpointEnvelope{Schema: 1, Runtime: runtimeVersion, State: codecEncode(t, cp)})
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func codecDecode(t *testing.T, b []byte) *rebindCheckpoint {
	t.Helper()
	var env checkpointEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatal(err)
	}
	var cp rebindCheckpoint
	if err := rebindGobDecode(env.State, &cp); err != nil {
		t.Fatal(err)
	}
	return &cp
}
func codecGraph(t *testing.T, cp *rebindCheckpoint) *rebindGraph {
	t.Helper()
	var g rebindGraph
	if err := rebindGobDecode(cp.InterruptID2State[cp.InfoDataSourceInterruptID].State.([]byte), &g); err != nil {
		t.Fatal(err)
	}
	return &g
}
func codecSetGraph(t *testing.T, cp *rebindCheckpoint, graph *rebindGraph) {
	t.Helper()
	id := cp.InfoDataSourceInterruptID
	st := cp.InterruptID2State[id]
	st.State = codecEncode(t, graph)
	cp.InterruptID2State[id] = st
}
func codecBusinessMap(id string) map[string]any {
	return map[string]any{"item_id": id, "text": codecOld, "evidence_id": "item:" + codecOld + ":hash", "material_hash": codecOld, "input_hash": codecOld, "completion_digest": codecOld, "object_key": "media/" + codecOld}
}
func codecBusinessJSON(id string) string {
	raw, _ := json.Marshal(codecBusinessObject(id))
	return string(raw)
}
func codecBusinessObject(id string) map[string]any {
	return map[string]any{"item_id": id,
		"citations":     []any{map[string]any{"id": id, "quote": codecOld}, map[string]any{"evidence_id": "item:" + codecOld + ":hash", "quote": codecOld}},
		"evidence":      []any{map[string]any{"item_id": id, "evidence_id": "item:" + codecOld + ":hash", "text": codecOld}},
		"material_hash": codecOld, "input_hash": codecOld, "object_key": "media/" + codecOld,
		"_completion": map[string]any{"digest": codecOld}, "text": codecOld}
}
func codecMessages(id string) []*schema.Message {
	return []*schema.Message{
		schema.UserMessage(`{"item_id":"` + codecOld + `"}`),
		schema.AssistantMessage("prose "+codecOld, []schema.ToolCall{
			{ID: "history-item", Type: "function", Function: schema.FunctionCall{Name: "get_item", Arguments: `{"item_id":"` + id + `","start":9007199254740993}`}},
			{ID: "history-analysis", Type: "function", Function: schema.FunctionCall{Name: "get_analysis", Arguments: `{"item_id":"` + id + `"}`}},
			{ID: "history-search", Type: "function", Function: schema.FunctionCall{Name: "search_items", Arguments: `{"query":"` + codecOld + `"}`}},
			{ID: "history-mcp", Type: "function", Function: schema.FunctionCall{Name: "mcp_other", Arguments: `{"item_id":"` + codecOld + `"}`}},
		}),
		{Role: schema.Tool, ToolCallID: "history-item", Content: codecBusinessJSON(id)},
		{Role: schema.Tool, ToolCallID: "history-analysis", Content: `{"item_id":"` + id + `","summary":"` + codecOld + `"}`},
		{Role: schema.Tool, ToolCallID: "history-search", Content: `{"items":[{"item_id":"` + id + `","snippet":"` + codecOld + `"}]}`},
		{Role: schema.Tool, ToolCallID: "history-mcp", Content: `{"item_id":"` + codecOld + `"}`},
	}
}
func codecAssertMessages(t *testing.T, messages []*schema.Message) {
	t.Helper()
	expected := codecMessages(codecNew)
	if len(messages) != len(expected) {
		t.Fatal("history length")
	}
	for i, message := range messages {
		want := expected[i]
		if message.Role == schema.Tool && message.ToolCallID != "history-mcp" {
			var a, b any
			if json.Unmarshal([]byte(message.Content), &a) != nil || json.Unmarshal([]byte(want.Content), &b) != nil || !reflect.DeepEqual(a, b) {
				t.Fatalf("tool result %d mismatch", i)
			}
			want.Content = message.Content
		}
		if !reflect.DeepEqual(message, want) {
			t.Fatalf("message %d history mismatch", i)
		}
	}
}

func TestCheckpointRebindAllSurfaces(t *testing.T) {
	_, store, _, _ := codecFixture(t)
	var cp rebindCheckpoint
	if err := rebindGobDecode(store.data, &cp); err != nil {
		t.Fatal(err)
	}
	cp.RunCtx.RootInput.Messages = codecMessages(codecOld)
	cp.RunCtx.Session.Values = codecBusinessMap(codecOld)
	for _, message := range codecMessages(codecOld) {
		cp.RunCtx.Session.Events = append(cp.RunCtx.Session.Events, &rebindEvent{AgentEvent: &adk.AgentEvent{AgentName: "research", Output: &adk.AgentOutput{MessageOutput: &adk.MessageVariant{Message: message}}}, TS: 123456789})
	}
	cp.RunCtx.Session.LaneEvents = &rebindLane{Events: cp.RunCtx.Session.Events, Parent: &rebindLane{Events: cp.RunCtx.Session.Events}}
	g := codecGraph(t, &cp)
	if g.State != nil || len(g.SubGraphs) == 0 {
		t.Fatal("fixture no longer matches native wrapper graph shape")
	}
	g.Inputs["test-history"] = codecMessages(codecOld)
	// A nested bridge remains a complete native checkpoint, not a partial State.
	g.InterruptID2State["nested-bridge"] = rebindInterruptState{State: codecEncode(t, g)}
	g.InterruptID2Addr["nested-bridge"] = compose.Address{{Type: "node", ID: "nested"}}
	var state *adk.State
	for _, sub := range g.SubGraphs {
		if s, ok := sub.State.(*adk.State); ok {
			state = s
		}
	}
	if state == nil {
		t.Fatal("native nested State missing")
	}
	state.Messages = codecMessages(codecOld)
	state.Extra = codecBusinessMap(codecOld)
	state.RetryAttempt = 2
	state.HasReturnDirectly = true
	state.ReturnDirectlyToolCallID = codecOld
	state.ToolGenActions = map[string]*adk.AgentAction{"opaque-action": {Exit: true}}
	state.DeferredToolInfos = state.ToolInfos
	state.ToolMsgIDs = map[string]map[string]string{"get_item": {"opaque-call": codecOld}}
	state.ReturnDirectlyEvent = &adk.AgentEvent{Output: &adk.AgentOutput{MessageOutput: &adk.MessageVariant{Message: schema.ToolMessage(`{"item_id":"`+codecOld+`","text":"`+codecOld+`"}`, "direct"), ToolName: "get_item"}}}
	for _, ch := range g.Channels {
		reflect.ValueOf(ch).Elem().FieldByName("Values").Interface().(map[string]any)["test-history"] = codecMessages(codecOld)
	}
	codecSetGraph(t, &cp, g)
	rebound, err := RebindCheckpointPayload(codecEnvelope(t, &cp), codecOld, codecNew)
	if err != nil {
		t.Fatal(err)
	}
	after := codecDecode(t, rebound)
	codecAssertMessages(t, after.RunCtx.RootInput.Messages)
	if !reflect.DeepEqual(after.RunCtx.Session.Values, codecBusinessMap(codecNew)) {
		t.Fatal("business refs or immutable fields changed")
	}
	for _, events := range [][]*rebindEvent{after.RunCtx.Session.Events, after.RunCtx.Session.LaneEvents.Events, after.RunCtx.Session.LaneEvents.Parent.Events} {
		messages := make([]*schema.Message, len(events))
		for i, e := range events {
			if e.TS != 123456789 {
				t.Fatal("event timestamp lost")
			}
			messages[i] = e.Output.MessageOutput.Message
		}
		codecAssertMessages(t, messages)
	}
	ag := codecGraph(t, after)
	var nested rebindGraph
	if err := rebindGobDecode(ag.InterruptID2State["nested-bridge"].State.([]byte), &nested); err != nil {
		t.Fatal(err)
	}
	foundPending := false
	for _, entry := range nested.InterruptID2State {
		if raw, ok := entry.State.(string); ok {
			var message schema.Message
			if json.Unmarshal([]byte(raw), &message) != nil || !strings.Contains(message.ToolCalls[0].Function.Arguments, codecNew) || message.Content != "prose "+codecOld {
				t.Fatal("nested bridge references/history")
			}
			foundPending = true
		}
	}
	if !foundPending {
		t.Fatal("nested bridge pending state lost")
	}
	codecAssertMessages(t, ag.Inputs["test-history"].([]*schema.Message))
	for _, sub := range ag.SubGraphs {
		if s, ok := sub.State.(*adk.State); ok {
			codecAssertMessages(t, s.Messages)
			if !reflect.DeepEqual(s.Extra, codecBusinessMap(codecNew)) || s.RetryAttempt != 2 || s.ToolMsgIDs["get_item"]["opaque-call"] != codecOld || s.RemainingIterations != state.RemainingIterations {
				t.Fatal("nested state field loss")
			}
			if !strings.Contains(s.ReturnDirectlyEvent.Output.MessageOutput.Message.Content, codecNew) {
				t.Fatal("direct event was not rebound")
			}
			expected := *state
			expected.Messages = s.Messages
			expected.Extra = s.Extra
			expected.ReturnDirectlyEvent = s.ReturnDirectlyEvent
			if !reflect.DeepEqual(&expected, s) {
				t.Fatal("other exported state field changed")
			}
		}
	}
	for _, ch := range ag.Channels {
		codecAssertMessages(t, reflect.ValueOf(ch).Elem().FieldByName("Values").Interface().(map[string]any)["test-history"].([]*schema.Message))
	}
	if !reflect.DeepEqual(g.SkipPreHandler, ag.SkipPreHandler) || !reflect.DeepEqual(g.RerunNodes, ag.RerunNodes) || !reflect.DeepEqual(g.InterruptID2Addr, ag.InterruptID2Addr) {
		t.Fatal("graph control state lost")
	}
}

// Builds and drives the exact production CLI with synthetic SDK checkpoints.
func TestCheckpointRebindCLI(t *testing.T) {
	binary := t.TempDir() + "/checkpoint-rebind.exe"
	build := exec.Command("go", "build", "-o", binary, "../../cmd/checkpoint-rebind")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("CLI build: %v %s", err, output)
	}
	_, store, _, _ := codecFixture(t)
	var cp rebindCheckpoint
	if err := rebindGobDecode(store.data, &cp); err != nil {
		t.Fatal(err)
	}
	payload := codecEnvelope(t, &cp)
	request, err := json.Marshal(map[string]any{"payload_base64": payload, "from_item_id": codecOld, "to_item_id": codecNew})
	if err != nil {
		t.Fatal(err)
	}
	for name, input := range map[string][]byte{
		"success":       request,
		"trailing":      append(append([]byte(nil), request...), []byte(` {}`)...),
		"unknown-field": append([]byte(`{"future":1,`), request[1:]...),
		"bad-base64":    []byte(`{"payload_base64":"!"}`),
		"unsupported":   []byte(`{"payload_base64":"YWJj","from_item_id":"old","to_item_id":"new"}`),
		"oversize":      bytes.Repeat([]byte(" "), 400000),
	} {
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command(binary)
			cmd.Stdin = bytes.NewReader(input)
			var out, stderr bytes.Buffer
			cmd.Stdout = &out
			cmd.Stderr = &stderr
			err := cmd.Run()
			if name != "success" {
				if err == nil || out.Len() != 0 || strings.TrimSpace(stderr.String()) != "checkpoint_rebind_failed" {
					t.Fatal("CLI did not refuse with sanitized error and empty stdout")
				}
				return
			}
			if err != nil || stderr.Len() != 0 {
				t.Fatalf("CLI failed: %v", err)
			}
			var response struct {
				Payload []byte `json:"payload_base64"`
			}
			if rebindJSONDecode(out.Bytes(), &response) != nil || len(response.Payload) == 0 {
				t.Fatal("CLI framing")
			}
			after := codecDecode(t, response.Payload)
			g := codecGraph(t, after)
			found := false
			for _, state := range g.InterruptID2State {
				if text, ok := state.State.(string); ok {
					var message schema.Message
					if json.Unmarshal([]byte(text), &message) != nil {
						t.Fatal("pending decode")
					}
					if !strings.Contains(message.ToolCalls[0].Function.Arguments, codecNew) || message.Content != "prose "+codecOld {
						t.Fatal("pending reference or prose")
					}
					found = true
				}
			}
			if !found {
				t.Fatal("pending model result lost")
			}
		})
	}
}

type codecUnknown struct{ ItemID string }

func TestCheckpointRebindRefuses(t *testing.T) {
	gob.Register(&codecUnknown{})
	_, store, _, _ := codecFixture(t)
	for name, mutate := range map[string]func(*rebindCheckpoint){
		"agentic":            func(c *rebindCheckpoint) { c.RunCtx.AgenticRootInput = "unsupported" },
		"typed-events":       func(c *rebindCheckpoint) { c.RunCtx.Session.TypedEvents = "unsupported" },
		"streaming":          func(c *rebindCheckpoint) { c.EnableStreaming = true },
		"unknown-value":      func(c *rebindCheckpoint) { c.RunCtx.Session.Values["future"] = &codecUnknown{codecOld} },
		"unknown-bytes":      func(c *rebindCheckpoint) { c.RunCtx.Session.Values["future"] = []byte(codecOld) },
		"missing-compaction": func(c *rebindCheckpoint) { c.InfoDataSourceInterruptID = "missing" },
		"double-compaction":  func(c *rebindCheckpoint) { c.Info.Data.(*adk.ChatModelAgentInterruptInfo).Data = []byte("other") },
		"inconsistent-inline": func(c *rebindCheckpoint) {
			c.Info.Data.(*adk.ChatModelAgentInterruptInfo).Data = []byte("other")
			c.InfoDataSourceInterruptID = ""
		},
		"invalid-arguments": func(c *rebindCheckpoint) {
			c.RunCtx.RootInput.Messages = []*schema.Message{schema.AssistantMessage("", []schema.ToolCall{{ID: "bad", Function: schema.FunctionCall{Name: "get_item", Arguments: "{"}}})}
		},
		"deep-state": func(c *rebindCheckpoint) {
			root := &rebindLane{}
			c.RunCtx.Session.LaneEvents = root
			for i := 0; i < 80; i++ {
				next := &rebindLane{}
				root.Parent = next
				root = next
			}
		},
		"pending-json": func(c *rebindCheckpoint) {
			g := codecGraph(t, c)
			for id, s := range g.InterruptID2State {
				if _, ok := s.State.(string); ok {
					s.State = "not-json"
					g.InterruptID2State[id] = s
				}
			}
			codecSetGraph(t, c, g)
		},
	} {
		t.Run(name, func(t *testing.T) {
			var cp rebindCheckpoint
			if err := rebindGobDecode(store.data, &cp); err != nil {
				t.Fatal(err)
			}
			mutate(&cp)
			payload := codecEnvelope(t, &cp)
			original := append([]byte(nil), payload...)
			out, err := RebindCheckpointPayload(payload, codecOld, codecNew)
			if err == nil || out != nil || !bytes.Equal(original, payload) {
				t.Fatal("unsupported checkpoint not refused atomically")
			}
		})
	}
	var cp rebindCheckpoint
	if err := rebindGobDecode(store.data, &cp); err != nil {
		t.Fatal(err)
	}
	base := codecEnvelope(t, &cp)
	for name, payload := range map[string][]byte{
		"runtime":       bytes.Replace(base, []byte(runtimeVersion), []byte("eino-v0.9.20"), 1),
		"schema":        bytes.Replace(base, []byte(`"schema":1`), []byte(`"schema":2`), 1),
		"unknown-field": append([]byte(`{"future":1,`), base[1:]...),
		"trailing":      append(append([]byte(nil), base...), []byte(` {}`)...),
		"oversize":      bytes.Repeat([]byte(" "), checkpointRebindLimit+1),
		"invalid":       []byte(`{"schema":1,"runtime":"eino-v0.9.19","state":"YWJj"}`),
	} {
		t.Run(name, func(t *testing.T) {
			out, err := RebindCheckpointPayload(payload, codecOld, codecNew)
			if err == nil || out != nil {
				t.Fatal("unsupported envelope accepted")
			}
		})
	}
}
func TestCheckpointRebindNoOpKeepsOriginalBytes(t *testing.T) {
	_, store, _, _ := codecFixture(t)
	var original rebindCheckpoint
	if err := rebindGobDecode(store.data, &original); err != nil {
		t.Fatal(err)
	}
	payload := codecEnvelope(t, &original)
	moved, err := RebindCheckpointPayload(payload, codecOld, codecNew)
	if err != nil {
		t.Fatal(err)
	}
	// Only immutable prose/tokens retain the old ID. Preserve envelope whitespace too.
	input := append([]byte(" \n"), moved...)
	unchanged, err := RebindCheckpointPayload(input, codecOld, codecNew)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(input, unchanged) {
		t.Fatal("unrelated checkpoint bytes changed")
	}
}
