package agent

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"errors"
	"io"
	"reflect"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

// ponytail: these complete concrete wire mirrors cover only Eino v0.9.19's
// ordinary, nonstreaming research runner. New SDK epochs need a new native
// resume regression and an explicit schema audit, not permissive decoding.
type rebindCheckpoint struct {
	RunCtx                    *rebindRunContext
	Info                      *adk.InterruptInfo
	InfoDataSourceInterruptID string
	EnableStreaming           bool
	InterruptID2Address       map[string]adk.Address
	InterruptID2State         map[string]rebindInterruptState
}
type rebindRunContext struct {
	RootInput        *adk.AgentInput
	RunPath          []adk.RunStep
	AgenticRootInput any
	Session          *rebindSession
}
type rebindSession struct {
	Values      map[string]any
	Events      []*rebindEvent
	LaneEvents  *rebindLane
	TypedEvents any
}
type rebindLane struct {
	Events []*rebindEvent
	Parent *rebindLane
}
type rebindEvent struct {
	*adk.AgentEvent
	TS        int64
	StreamErr error
}
type rebindEventWire rebindEvent

func (e *rebindEvent) GobDecode(b []byte) error   { return rebindGobDecode(b, (*rebindEventWire)(e)) }
func (e *rebindEvent) GobEncode() ([]byte, error) { return rebindGobEncode((*rebindEventWire)(e)) }

type rebindInterruptState struct {
	State                any
	LayerSpecificPayload any
}
type rebindGraph struct {
	Channels          map[string]any
	Inputs            map[string]any
	State             any
	SkipPreHandler    map[string]bool
	RerunNodes        []string
	SubGraphs         map[string]*rebindGraph
	InterruptID2Addr  map[string]compose.Address
	InterruptID2State map[string]rebindInterruptState
}

var errCheckpointRebind = errors.New("checkpoint_rebind_unsupported")

// Matches src/lib/server/agent-checkpoints.ts's persisted envelope limit.
const checkpointRebindLimit = 256 * 1024

// RebindCheckpointPayload rewrites the full PostgreSQL bytea envelope. Failure
// returns no candidate payload; callers must keep the original item group intact.
func RebindCheckpointPayload(payload []byte, fromItemID, toItemID string) ([]byte, error) {
	if len(payload) == 0 || len(payload) > checkpointRebindLimit || fromItemID == "" || toItemID == "" || len(fromItemID) > 128 || len(toItemID) > 128 {
		return nil, errCheckpointRebind
	}
	var env checkpointEnvelope
	if rebindJSONDecode(payload, &env) != nil || env.Schema != 1 || env.Runtime != runtimeVersion || len(env.State) == 0 {
		return nil, errCheckpointRebind
	}
	var checkpoint rebindCheckpoint
	if rebindGobDecode(env.State, &checkpoint) != nil {
		return nil, errCheckpointRebind
	}
	w := &checkpointRebinder{from: fromItemID, to: toItemID, calls: map[string]string{}, pending: map[string]bool{}, bridges: map[string][]byte{}}
	// Gather tool-call identities across all copies before visiting tool results.
	if w.root(&checkpoint) != nil {
		return nil, errCheckpointRebind
	}
	w.apply = true
	if w.root(&checkpoint) != nil {
		return nil, errCheckpointRebind
	}
	for i := range env.Evidence {
		if env.Evidence[i].ItemID != nil && *env.Evidence[i].ItemID == fromItemID && fromItemID != toItemID {
			w.changed = true
			id := toItemID
			env.Evidence[i].ItemID = &id
		}
	}
	// Fully decode and traverse even no-op candidates: unsupported states must
	// still fail closed. Valid unrelated histories keep their exact original bytes.
	if !w.changed {
		return append([]byte(nil), payload...), nil
	}
	state, err := rebindGobEncode(&checkpoint)
	if err != nil {
		return nil, errCheckpointRebind
	}
	// Check every nested codec again after encoding, before exposing a candidate.
	var verified rebindCheckpoint
	if rebindGobDecode(state, &verified) != nil {
		return nil, errCheckpointRebind
	}
	w.apply = false
	if w.root(&verified) != nil {
		return nil, errCheckpointRebind
	}
	env.State = state
	out, err := json.Marshal(env)
	if err != nil || len(out) > checkpointRebindLimit {
		return nil, errCheckpointRebind
	}
	return out, nil
}

func rebindGobDecode(b []byte, v any) error {
	if len(b) == 0 || len(b) > checkpointRebindLimit {
		return errCheckpointRebind
	}
	d := gob.NewDecoder(bytes.NewReader(b))
	if err := d.Decode(v); err != nil {
		return errCheckpointRebind
	}
	if d.Decode(new(any)) != io.EOF {
		return errCheckpointRebind
	}
	return nil
}
func rebindGobEncode(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := gob.NewEncoder(&b).Encode(v); err != nil || b.Len() > checkpointRebindLimit {
		return nil, errCheckpointRebind
	}
	return b.Bytes(), nil
}
func rebindJSONDecode(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	d.UseNumber()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return errCheckpointRebind
	}
	return nil
}

type checkpointRebinder struct {
	from, to string
	apply    bool
	changed  bool
	calls    map[string]string
	pending  map[string]bool
	bridges  map[string][]byte
}

func (w *checkpointRebinder) root(cp *rebindCheckpoint) error {
	if cp.EnableStreaming || cp.RunCtx == nil || cp.RunCtx.AgenticRootInput != nil || cp.RunCtx.RootInput == nil || cp.RunCtx.RootInput.EnableStreaming || cp.RunCtx.Session == nil || cp.RunCtx.Session.TypedEvents != nil {
		return errCheckpointRebind
	}
	if cp.Info == nil {
		return errCheckpointRebind
	}
	bridgeInfo, ok := cp.Info.Data.(*adk.ChatModelAgentInterruptInfo)
	if !ok || bridgeInfo == nil {
		return errCheckpointRebind
	}
	if cp.InfoDataSourceInterruptID != "" {
		if cp.Info == nil {
			return errCheckpointRebind
		}
		info, ok := cp.Info.Data.(*adk.ChatModelAgentInterruptInfo)
		bridge, present := cp.InterruptID2State[cp.InfoDataSourceInterruptID]
		data, bytesOK := bridge.State.([]byte)
		if !ok || info == nil || len(info.Data) != 0 || !present || !bytesOK || len(data) == 0 {
			return errCheckpointRebind
		}
	} else {
		if len(bridgeInfo.Data) == 0 {
			return errCheckpointRebind
		}
		// Inline and persisted root bridge copies must describe the same graph.
		found := false
		for id, entry := range cp.InterruptID2State {
			address := cp.InterruptID2Address[id]
			if len(address) == 1 && address[0].Type == "agent" {
				data, ok := entry.State.([]byte)
				if !ok || !bytes.Equal(data, bridgeInfo.Data) {
					return errCheckpointRebind
				}
				found = true
			}
		}
		if !found {
			return errCheckpointRebind
		}
	}
	if err := w.interruptInfo(cp.Info, 0); err != nil {
		return err
	}
	if err := w.messages(cp.RunCtx.RootInput.Messages, 0); err != nil {
		return err
	}
	s := cp.RunCtx.Session
	if err := w.fields(s.Values, 0); err != nil {
		return err
	}
	if err := w.events(s.Events, 0); err != nil {
		return err
	}
	for lane, depth := s.LaneEvents, 0; lane != nil; lane, depth = lane.Parent, depth+1 {
		if depth > 64 {
			return errCheckpointRebind
		}
		if err := w.events(lane.Events, depth); err != nil {
			return err
		}
	}
	return w.interruptStates(cp.InterruptID2State, cp.InterruptID2Address, 0)
}

func (w *checkpointRebinder) events(events []*rebindEvent, depth int) error {
	for _, event := range events {
		if event == nil || event.StreamErr != nil {
			return errCheckpointRebind
		}
		if err := w.event(event.AgentEvent, depth+1); err != nil {
			return err
		}
	}
	return nil
}
func (w *checkpointRebinder) event(event *adk.AgentEvent, depth int) error {
	if depth > 64 {
		return errCheckpointRebind
	}
	if event == nil {
		return nil
	}
	if event.Err != nil {
		return errCheckpointRebind
	}
	if event.Output != nil {
		if event.Output.CustomizedOutput != nil {
			return errCheckpointRebind
		}
		if mv := event.Output.MessageOutput; mv != nil {
			if mv.IsStreaming || mv.MessageStream != nil {
				return errCheckpointRebind
			}
			if err := w.message(mv.Message, mv.ToolName, depth+1); err != nil {
				return err
			}
		}
	}
	return w.action(event.Action, depth+1)
}
func (w *checkpointRebinder) action(action *adk.AgentAction, depth int) error {
	if action == nil {
		return nil
	}
	if depth > 64 || action.CustomizedAction != nil || action.TransferToAgent != nil || action.BreakLoop != nil {
		return errCheckpointRebind
	}
	return w.interruptInfo(action.Interrupted, depth+1)
}
func (w *checkpointRebinder) contexts(contexts []*adk.InterruptCtx, depth int) error {
	for _, context := range contexts {
		for c, d := context, depth; c != nil; c, d = c.Parent, d+1 {
			if d > 64 {
				return errCheckpointRebind
			}
			if reason, ok := c.Info.(string); ok && reason == "model_result_saved" {
				w.pending[c.ID] = true
			}
			if err := w.value(c.Info, d+1); err != nil {
				return err
			}
		}
	}
	return nil
}
func (w *checkpointRebinder) interruptInfo(info *adk.InterruptInfo, depth int) error {
	if info == nil {
		return nil
	}
	if depth > 64 {
		return errCheckpointRebind
	}
	if err := w.contexts(info.InterruptContexts, depth+1); err != nil {
		return err
	}
	if info.Data == nil {
		return nil
	}
	bridge, ok := info.Data.(*adk.ChatModelAgentInterruptInfo)
	if !ok || bridge == nil {
		return errCheckpointRebind
	}
	if err := w.composeInfo(bridge.Info, depth+1); err != nil {
		return err
	}
	if len(bridge.Data) != 0 {
		data, err := w.graphBytes(bridge.Data, depth+1)
		if err != nil {
			return err
		}
		if w.apply {
			bridge.Data = data
		}
	}
	return nil
}
func (w *checkpointRebinder) composeInfo(info *compose.InterruptInfo, depth int) error {
	if info == nil {
		return nil
	}
	if depth > 64 {
		return errCheckpointRebind
	}
	if err := w.contexts(info.InterruptContexts, depth+1); err != nil {
		return err
	}
	if err := w.value(info.State, depth+1); err != nil {
		return err
	}
	if err := w.fields(info.RerunNodesExtra, depth+1); err != nil {
		return err
	}
	for _, sub := range info.SubGraphs {
		if err := w.composeInfo(sub, depth+1); err != nil {
			return err
		}
	}
	return nil
}
func (w *checkpointRebinder) interruptStates(states map[string]rebindInterruptState, addresses map[string]adk.Address, depth int) error {
	if depth > 64 {
		return errCheckpointRebind
	}
	for id, state := range states {
		if _, ok := addresses[id]; !ok {
			return errCheckpointRebind
		}
		switch v := state.State.(type) {
		case []byte:
			data, err := w.graphBytes(v, depth+1)
			if err != nil {
				return err
			}
			if w.apply {
				state.State = data
			}
		case string:
			if !w.pending[id] {
				return errCheckpointRebind
			}
			var message schema.Message
			if rebindJSONDecode([]byte(v), &message) != nil || message.Role != schema.Assistant {
				return errCheckpointRebind
			}
			if err := w.message(&message, "", depth+1); err != nil {
				return err
			}
			if w.apply {
				raw, err := json.Marshal(&message)
				if err != nil {
					return errCheckpointRebind
				}
				state.State = string(raw)
			}
		default:
			if err := w.value(v, depth+1); err != nil {
				return err
			}
		}
		switch v := state.LayerSpecificPayload.(type) {
		case nil, []adk.RunStep:
		default:
			if err := w.value(v, depth+1); err != nil {
				return err
			}
		}
		if w.apply {
			states[id] = state
		}
	}
	return nil
}
func (w *checkpointRebinder) graphBytes(data []byte, depth int) ([]byte, error) {
	if depth > 64 {
		return nil, errCheckpointRebind
	}
	// Gob map ordering is not deterministic. Reuse identical bridge copies so
	// the SDK's compaction equality and inline-copy consistency remain intact.
	if w.apply {
		if rebound, ok := w.bridges[string(data)]; ok {
			return rebound, nil
		}
	}
	var graph rebindGraph
	if rebindGobDecode(data, &graph) != nil || graph.Channels == nil {
		return nil, errCheckpointRebind
	}
	if err := w.graph(&graph, depth+1); err != nil {
		return nil, err
	}
	if !w.apply {
		return data, nil
	}
	rebound, err := rebindGobEncode(&graph)
	if err == nil {
		w.bridges[string(data)] = rebound
	}
	return rebound, err
}
func (w *checkpointRebinder) graph(graph *rebindGraph, depth int) error {
	if graph == nil || depth > 64 {
		return errCheckpointRebind
	}
	if err := w.value(graph.State, depth+1); err != nil {
		return err
	}
	for _, v := range graph.Inputs {
		if err := w.value(v, depth+1); err != nil {
			return err
		}
	}
	for _, channel := range graph.Channels {
		v := reflect.ValueOf(channel)
		if !v.IsValid() || v.Kind() != reflect.Pointer || v.IsNil() {
			return errCheckpointRebind
		}
		typ := v.Type().Elem()
		if typ.PkgPath() != "github.com/cloudwego/eino/compose" || (typ.Name() != "dagChannel" && typ.Name() != "pregelChannel") {
			return errCheckpointRebind
		}
		values, ok := v.Elem().FieldByName("Values").Interface().(map[string]any)
		if !ok {
			return errCheckpointRebind
		}
		for _, value := range values {
			if err := w.value(value, depth+1); err != nil {
				return err
			}
		}
	}
	for _, sub := range graph.SubGraphs {
		if err := w.graph(sub, depth+1); err != nil {
			return err
		}
	}
	return w.interruptStates(graph.InterruptID2State, graph.InterruptID2Addr, depth+1)
}

func (w *checkpointRebinder) value(value any, depth int) error {
	if depth > 64 {
		return errCheckpointRebind
	}
	switch v := value.(type) {
	case nil, string, bool, int, int64, float64, json.Number, []string:
		return nil
	case *schema.Message:
		return w.message(v, "", depth+1)
	case []*schema.Message:
		return w.messages(v, depth+1)
	case *adk.State:
		if v == nil {
			return errCheckpointRebind
		}
		if err := w.messages(v.Messages, depth+1); err != nil {
			return err
		}
		if err := w.fields(v.Extra, depth+1); err != nil {
			return err
		}
		for _, action := range v.ToolGenActions {
			if err := w.action(action, depth+1); err != nil {
				return err
			}
		}
		return w.event(v.ReturnDirectlyEvent, depth+1)
	case *adk.AgentEvent:
		return w.event(v, depth+1)
	case map[string]any:
		return w.fields(v, depth+1)
	case []any:
		for _, entry := range v {
			if err := w.value(entry, depth+1); err != nil {
				return err
			}
		}
		return nil
	default:
		return errCheckpointRebind
	}
}

func (w *checkpointRebinder) fields(fields map[string]any, depth int) error {
	if depth > 64 {
		return errCheckpointRebind
	}
	for key, value := range fields {
		switch key {
		case "item_id":
			if value == nil {
				continue
			}
			id, ok := value.(string)
			if !ok {
				return errCheckpointRebind
			}
			if w.apply && id == w.from && w.from != w.to {
				w.changed = true
				fields[key] = w.to
			}
		case "citations":
			entries, ok := value.([]any)
			if !ok && value != nil {
				return errCheckpointRebind
			}
			for _, entry := range entries {
				citation, ok := entry.(map[string]any)
				if !ok {
					return errCheckpointRebind
				}
				if id, exists := citation["id"]; exists {
					text, ok := id.(string)
					if !ok {
						return errCheckpointRebind
					}
					if w.apply && text == w.from && w.from != w.to {
						w.changed = true
						citation["id"] = w.to
					}
				}
				if err := w.fields(citation, depth+1); err != nil {
					return err
				}
			}
		default:
			if err := w.value(value, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
func (w *checkpointRebinder) messages(messages []*schema.Message, depth int) error {
	for _, message := range messages {
		if err := w.message(message, "", depth+1); err != nil {
			return err
		}
	}
	return nil
}
func (w *checkpointRebinder) message(message *schema.Message, toolName string, depth int) error {
	if message == nil || depth > 64 {
		return errCheckpointRebind
	}
	for i := range message.ToolCalls {
		call := &message.ToolCalls[i]
		if call.ID == "" || call.Function.Name == "" {
			return errCheckpointRebind
		}
		if name, ok := w.calls[call.ID]; ok && name != call.Function.Name {
			return errCheckpointRebind
		}
		w.calls[call.ID] = call.Function.Name
		if call.Function.Name == "get_item" || call.Function.Name == "get_analysis" {
			var args map[string]any
			if rebindJSONDecode([]byte(call.Function.Arguments), &args) != nil {
				return errCheckpointRebind
			}
			id, ok := args["item_id"].(string)
			if !ok || id == "" {
				return errCheckpointRebind
			}
			if w.apply && id == w.from && w.from != w.to {
				w.changed = true
				args["item_id"] = w.to
				raw, err := json.Marshal(args)
				if err != nil {
					return errCheckpointRebind
				}
				call.Function.Arguments = string(raw)
			}
		}
	}
	if message.Role != schema.Tool || !w.apply {
		return nil
	}
	name := message.ToolName
	if name == "" {
		name = toolName
	}
	if called := w.calls[message.ToolCallID]; called != "" {
		if name != "" && name != called {
			return errCheckpointRebind
		}
		name = called
	}
	if name == "" {
		return errCheckpointRebind
	}
	if name != "get_item" && name != "get_analysis" && name != "search_items" {
		return nil
	}
	var result map[string]any
	if rebindJSONDecode([]byte(message.Content), &result) != nil || result == nil {
		return errCheckpointRebind
	}
	if name == "search_items" {
		items, ok := result["items"].([]any)
		if !ok {
			return errCheckpointRebind
		}
		for _, entry := range items {
			item, ok := entry.(map[string]any)
			if !ok {
				return errCheckpointRebind
			}
			if _, ok := item["item_id"].(string); !ok {
				return errCheckpointRebind
			}
		}
	} else if _, ok := result["item_id"].(string); !ok {
		return errCheckpointRebind
	}
	if err := w.fields(result, depth+1); err != nil {
		return err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return errCheckpointRebind
	}
	message.Content = string(raw)
	return nil
}
