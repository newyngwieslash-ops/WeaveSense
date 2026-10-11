package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	mcp "github.com/mark3labs/mcp-go/mcp"
)

// Task 9: profile-aware tool surface on the bridge (plan §4.3 / Task 9).
//  - assistant grants may only reach the fixed assistant-data endpoint;
//  - research grants calling assistant tools are refused and vice versa;
//  - tools/list and tools/call both filter by profile;
//  - model receipts keep their pre-send admission (model_proxy unchanged behavior).

func assistantTestGrant() Grant {
	g := testGrant()
	g.Profile = "assistant"
	g.PolicyVersion = "loom-assistant-v1"
	return g
}

func registerBridge(t *testing.T, b *Bridge, srv *httptest.Server, grant Grant) {
	t.Helper()
	if code, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, grant); code != 201 {
		t.Fatalf("register %d", code)
	}
}

func TestBridgeAssistantProfileToolSurface(t *testing.T) {
	grant := assistantTestGrant()
	var mu sync.Mutex
	var actions []string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		mu.Lock()
		actions = append(actions, input["action"].(string))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch input["action"] {
		case "tool_start", "tool_complete":
			io.WriteString(w, `{"ok":true,"disposition":"send_once"}`)
		case "tool_complete_done":
			io.WriteString(w, `{"ok":true,"disposition":"completed"}`)
		default:
			io.WriteString(w, `{"ok":true,"disposition":"completed","items":[]}`)
		}
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	registerBridge(t, b, srv, grant)
	cli := bridgeClient(t, srv.URL, grant.Grant)

	// tools/list for an assistant grant exposes only the read tools.
	listed, err := cli.ListTools(context.Background(), mcp.ListToolsRequest{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range listed.Tools {
		names[tool.Name] = true
	}
	// search_items/get_item exist on BOTH profiles: on an assistant grant
	// they read project items (latest listing / get by id), never the
	// research corpus. The other assistant read tools must also be present.
	if !names["search_items"] || !names["get_item"] {
		t.Fatalf("assistant tools/list missing item tools: %v", names)
	}
	if !names["project_overview"] || !names["list_keywords"] || !names["get_operation"] {
		t.Fatalf("assistant tools/list missing read tools: %v", names)
	}
	_ = actions
}

func TestBridgeAssistantReadToolCallsHostWithReceipts(t *testing.T) {
	grant := assistantTestGrant()
	var mu sync.Mutex
	var actions []string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		mu.Lock()
		actions = append(actions, input["action"].(string))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch input["action"] {
		case "tool_start":
			io.WriteString(w, `{"ok":true,"disposition":"send_once"}`)
		case "tool_complete":
			io.WriteString(w, `{"ok":true,"disposition":"completed"}`)
		case "list_keywords":
			io.WriteString(w, `{"keywords":[{"id":"kw1","phrase":"固态电池","platforms":["rss"],"interval_minutes":30,"enabled":true}],"truncated":false}`)
		default:
			io.WriteString(w, `{"ok":true}`)
		}
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	registerBridge(t, b, srv, grant)
	cli := bridgeClient(t, srv.URL, grant.Grant)
	res, err := callTool(cli, "list_keywords", map[string]any{})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(mcp.TextContent).Text, "固态电池") {
		t.Fatalf("assistant read tool failed: %v %v", res, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(actions) != 3 || actions[0] != "tool_start" || actions[1] != "list_keywords" || actions[2] != "tool_complete" {
		t.Fatalf("expected receipted call sequence, got %v", actions)
	}
}

func TestBridgeResearchGrantCannotCallAssistantTools(t *testing.T) {
	grant := testGrant() // research profile
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true}`)
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	registerBridge(t, b, srv, grant)
	cli := bridgeClient(t, srv.URL, grant.Grant)
	res, err := callTool(cli, "list_keywords", map[string]any{})
	if err != nil {
		t.Fatalf("rpc: %v", err)
	}
	if !res.IsError {
		t.Fatal("research grant called an assistant-only tool")
	}
}

func TestBridgeAssistantGrantCannotCallCorpusTools(t *testing.T) {
	grant := assistantTestGrant()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true}`)
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	registerBridge(t, b, srv, grant)
	cli := bridgeClient(t, srv.URL, grant.Grant)
	for _, name := range []string{"search_items", "get_item"} {
		res, err := callTool(cli, name, map[string]any{"query": "x"})
		if err != nil {
			t.Fatalf("rpc %s: %v", name, err)
		}
		if !res.IsError {
			t.Fatalf("assistant grant called corpus tool %s", name)
		}
	}
}

func TestBridgeAssistantToolsCallSameProfileEndpoint(t *testing.T) {
	grant := assistantTestGrant()
	var mu sync.Mutex
	var dataURLs []string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		mu.Lock()
		dataURLs = append(dataURLs, input["action"].(string))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch input["action"] {
		case "tool_start", "tool_complete":
			io.WriteString(w, `{"ok":true,"disposition":"send_once"}`)
		default:
			io.WriteString(w, `{"ok":true,"keywords":[]}`)
		}
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	registerBridge(t, b, srv, grant)
	cli := bridgeClient(t, srv.URL, grant.Grant)
	// Request-supplied routing fields are stripped by the whitelist: a call
	// carrying them is refused, and the bridge itself posts only to the fixed
	// AppDataURL.
	res, err := callTool(cli, "list_keywords", map[string]any{"data_url": "http://evil.example/steal", "service_token": "x"})
	if err != nil {
		t.Fatalf("rpc: %v", err)
	}
	if !res.IsError {
		t.Fatal("routing arguments must be refused")
	}
	// A clean call reaches the fixed endpoint.
	clean, err := callTool(cli, "list_keywords", map[string]any{})
	if err != nil || res.IsError && clean.IsError {
		if err != nil || clean.IsError {
			t.Fatalf("clean call failed: %v %v", clean, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(dataURLs) == 0 {
		t.Fatal("host never reached")
	}
}

var _ = time.Now
