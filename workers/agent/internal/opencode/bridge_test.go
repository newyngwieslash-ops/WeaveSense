package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

const bridgeControl = "trusted-controller-token-0123456789"

func testGrant() Grant {
	return Grant{Grant: strings.Repeat("g", 32), RunID: uuid.NewString(), ClaimToken: uuid.NewString(), InstanceID: uuid.NewString(), Epoch: uuid.NewString(), ExpiresAt: time.Now().Add(time.Minute), DataAccessToken: strings.Repeat("r", 64), Model: "research-fixed", PolicyVersion: "loom-agent-v1", MaxOutputTokensPerCall: 1800}
}

func grantRequest(t *testing.T, srv string, method, token string, input any) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(method, srv+"/v1/grants", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

func bridgeClient(t *testing.T, url, grant string) *mcpclient.Client {
	t.Helper()
	cli, err := mcpclient.NewStreamableHttpClient(url+"/mcp", transport.WithHTTPHeaders(map[string]string{"Authorization": "Bearer " + grant, "X-Agent-Run-Token": "forged-runtime-token"}), transport.WithHTTPBasicClient(&http.Client{Timeout: 2 * time.Second}))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := cli.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	req := mcp.InitializeRequest{}
	req.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	req.Params.ClientInfo = mcp.Implementation{Name: "bridge-test", Version: "1"}
	if _, err := cli.Initialize(ctx, req); err != nil {
		t.Fatal(err)
	}
	return cli
}

func callTool(cli *mcpclient.Client, name string, args any) (*mcp.CallToolResult, error) {
	req := mcp.CallToolRequest{}
	req.Params.Name, req.Params.Arguments = name, args
	return cli.CallTool(context.Background(), req)
}

func TestBridgeOnlyCorpusToolsAndHostProvenance(t *testing.T) {
	grant := testGrant()
	var mu sync.Mutex
	var calls []map[string]any
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer app-secret" || r.Header.Get("X-Agent-Run-Token") != grant.DataAccessToken {
			t.Error("host credentials changed")
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		mu.Lock()
		calls = append(calls, input)
		mu.Unlock()
		if input["run_id"] != grant.RunID || input["claim_token"] != grant.ClaimToken {
			t.Error("host grant mapping changed")
		}
		w.Header().Set("Content-Type", "application/json")
		switch input["action"] {
		case "tool_start":
			io.WriteString(w, `{"ok":true,"disposition":"send_once"}`)
		case "tool_complete":
			io.WriteString(w, `{"ok":true,"disposition":"completed"}`)
		case "search_items":
			io.WriteString(w, `{"items":[{"item_id":"doc","evidence_id":"host-evidence","snippet":"<证据>&\u2028正文","coverage":"partial"}]}`)
		case "get_item":
			io.WriteString(w, `{"item_id":"doc","evidence_id":"host-fragment","start":2,"end":4,"text":"证据","coverage":"partial"}`)
		default:
			t.Errorf("unexpected action %v", input["action"])
			w.WriteHeader(400)
		}
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	if code, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, grant); code != 201 {
		t.Fatalf("register %d", code)
	}
	cli := bridgeClient(t, srv.URL, grant.Grant)
	listed, err := cli.ListTools(context.Background(), mcp.ListToolsRequest{})
	if err != nil || len(listed.Tools) != 2 {
		t.Fatalf("tools %v %v", listed, err)
	}
	names := map[string]bool{}
	for _, tool := range listed.Tools {
		names[tool.Name] = true
	}
	if !names["search_items"] || !names["get_item"] {
		t.Fatalf("wrong tools %v", names)
	}
	query := "<证据>&\u2028\\u2028"
	res, err := callTool(cli, "search_items", map[string]any{"query": query})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(mcp.TextContent).Text, "host-evidence") {
		t.Fatalf("result %v %v", res, err)
	}
	res, err = callTool(cli, "get_item", map[string]any{"item_id": "doc", "start": 2})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(mcp.TextContent).Text, "host-fragment") {
		t.Fatalf("fragment %v %v", res, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 6 {
		t.Fatalf("expected start/read/complete per RPC, got %d", len(calls))
	}
	for i := 0; i < len(calls); i += 3 {
		start, read, complete := calls[i]["params"].(map[string]any), calls[i+1]["params"].(map[string]any), calls[i+2]["params"].(map[string]any)
		if start["call_id"] != read["call_id"] || start["call_id"] != complete["call_id"] || start["request_digest"] != read["request_digest"] || start["request_digest"] != complete["request_digest"] {
			t.Fatal("unstable tool intent")
		}
		if _, err := uuid.Parse(start["call_id"].(string)); err != nil {
			t.Fatal(err)
		}
	}
	actual := calls[0]["params"].(map[string]any)["request_digest"]
	expected, _ := canonicalHash(map[string]any{"tool": "search_items", "params": map[string]any{"query": query, "limit": 8}})
	if actual != expected {
		t.Fatalf("bad digest %v != %s", actual, expected)
	}
}

func TestBridgeGrantAuthenticationImmutabilityExpiryAndRevocation(t *testing.T) {
	var calls int
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	g := testGrant()
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, g.Grant, g); status != 401 {
		t.Fatalf("model registered mapping: %d", status)
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatalf("register %d", status)
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 200 {
		t.Fatalf("idempotent register %d", status)
	}
	changed := g
	changed.RunID = uuid.NewString()
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, changed); status != 409 {
		t.Fatalf("mapping mutation %d", status)
	}
	cli := bridgeClient(t, srv.URL, g.Grant)
	for _, params := range []map[string]any{{"query": "safe", "run_id": uuid.NewString()}, {"query": "safe", "grant": "foreign"}, {"query": "safe", "epoch": uuid.NewString()}, {"query": "safe", "data_access_token": "foreign"}, {"query": "safe", "limit": 9}, {"query": "safe", "limit": nil}, {"query": strings.Repeat("😀", 201)}, {"query": "a"}, {"item_id": "doc", "start": 0.5}, {"item_id": "doc", "start": -1}, {"item_id": "doc", "start": nil}, {"item_id": strings.Repeat("x", 257)}} {
		name := "search_items"
		if _, ok := params["item_id"]; ok {
			name = "get_item"
		}
		res, err := callTool(cli, name, params)
		if err == nil && !res.IsError {
			t.Errorf("unsafe params accepted %v", params)
		}
	}
	if res, err := callTool(cli, "write_note", map[string]any{}); err == nil && !res.IsError {
		t.Error("unexpected write tool")
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, map[string]string{"grant": g.Grant}); status != 200 {
		t.Fatalf("revoke %d", status)
	}
	if _, err := callTool(cli, "search_items", map[string]any{"query": "safe"}); err == nil {
		t.Error("revoked grant accepted")
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 409 {
		t.Fatalf("revoked nonce revived %d", status)
	}
	newNonce := g
	newNonce.Grant = strings.Repeat("n", 32)
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, newNonce); status != 409 {
		t.Fatalf("revoked epoch revived %d", status)
	}
	g.Grant = strings.Repeat("e", 32)
	g.ExpiresAt = time.Now().Add(-time.Second)
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 400 {
		t.Fatalf("expired grant registered %d", status)
	}
	if calls != 0 {
		t.Fatalf("unauthorized calls reached app: %d", calls)
	}
}

func TestBridgeAlreadyStartedAndOversizedResponsesNeverReleaseEvidence(t *testing.T) {
	for _, mode := range []string{"already_started", "completed", "denied", "oversized", "redirect", "nonjson"} {
		t.Run(mode, func(t *testing.T) {
			var actions []string
			app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var in map[string]any
				_ = json.NewDecoder(r.Body).Decode(&in)
				action := in["action"].(string)
				actions = append(actions, action)
				w.Header().Set("Content-Type", "application/json")
				if action == "tool_start" {
					if mode == "already_started" || mode == "completed" || mode == "denied" {
						io.WriteString(w, `{"ok":true,"disposition":"`+mode+`"}`)
					} else {
						io.WriteString(w, `{"ok":true,"disposition":"send_once"}`)
					}
					return
				}
				if mode == "oversized" {
					io.WriteString(w, `{"text":"`+strings.Repeat("x", 2*1024*1024)+`"}`)
				}
				if mode == "redirect" {
					http.Redirect(w, r, "/leak", 302)
				}
				if mode == "nonjson" {
					io.WriteString(w, "not json")
				}
			}))
			defer app.Close()
			b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl})
			srv := httptest.NewServer(b.Handler())
			defer srv.Close()
			g := testGrant()
			if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
				t.Fatal(status)
			}
			res, err := callTool(bridgeClient(t, srv.URL, g.Grant), "get_item", map[string]any{"item_id": "doc"})
			if err == nil && !res.IsError {
				t.Fatal("unproven response released")
			}
			want := 2
			if mode == "already_started" || mode == "completed" || mode == "denied" {
				want = 1
			}
			if len(actions) != want {
				t.Fatalf("app actions %v", actions)
			}
		})
	}
}

func TestBridgeInboundByteCapAndSecretStore(t *testing.T) {
	b := NewBridge(BridgeConfig{AppDataURL: "http://127.0.0.1:1", AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	g := testGrant()
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatal(status)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", strings.NewReader(strings.Repeat("x", 64*1024+1)))
	req.Header.Set("Authorization", "Bearer "+g.Grant)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 413 {
		t.Fatalf("byte cap %d", res.StatusCode)
	}
	auth, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", nil)
	auth.Header.Set("Authorization", "Bearer "+g.Grant)
	stored, ok := b.authorizeGrant(auth)
	if !ok || stored.Grant != "" {
		t.Fatal("raw opaque grant retained in mapping")
	}
	if _, err := b.postData(context.Background(), stored, "get_item", map[string]any{"item_id": "doc"}); err == nil {
		t.Fatal("missing app did not fail closed")
	}
}

func TestBridgeCanonicalJSONMatchesHostStringEscapes(t *testing.T) {
	raw, err := canonicalJSON(map[string]any{"tool": "search_items", "params": map[string]any{"query": "<>&\u2028\u2029\\u2028", "limit": 8}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"params":{"limit":8,"query":"<>&` + "\u2028\u2029" + `\\u2028"},"tool":"search_items"}`
	if string(raw) != want {
		t.Fatalf("canonical mismatch %q != %q", raw, want)
	}
}

func TestBridgeExpiryAndRevocationCancelActiveHostRequests(t *testing.T) {
	started := make(chan struct{})
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer app.Close()
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl, AllowedModel: "research-fixed"})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	g := testGrant()
	wrong := g
	wrong.Model = "other-model"
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, wrong); status != 400 {
		t.Fatalf("unpriced model grant %d", status)
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatal(status)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+g.Grant)
	stored, ok := b.authorizeGrant(req)
	if !ok {
		t.Fatal("grant not active")
	}
	done := make(chan error, 1)
	go func() {
		_, err := b.postData(context.Background(), stored, "get_item", map[string]any{"item_id": "doc"})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("host request did not start")
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, map[string]string{"grant": g.Grant}); status != 200 {
		t.Fatal(status)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("revoked call succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("revoke failed to cancel host request")
	}
	if _, ok := b.authorizeGrant(req); ok {
		t.Fatal("revoked grant active")
	}

	g = testGrant()
	g.Grant = strings.Repeat("e", 32)
	g.ExpiresAt = time.Now().Add(time.Second)
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatal(status)
	}
	time.Sleep(time.Until(g.ExpiresAt) + 10*time.Millisecond)
	req.Header.Set("Authorization", "Bearer "+g.Grant)
	if _, ok := b.authorizeGrant(req); ok {
		t.Fatal("expired grant active")
	}
}

func TestBridgeIdentityRevocationCannotCrossEpoch(t *testing.T) {
	b := NewBridge(BridgeConfig{AppDataURL: "http://127.0.0.1:1", AppServiceToken: "app-secret", ControlToken: bridgeControl})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	g := testGrant()
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatal(status)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+g.Grant)
	wrong := map[string]string{"instance_id": g.InstanceID, "epoch": uuid.NewString()}
	if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, wrong); status != 200 {
		t.Fatal(status)
	}
	if _, ok := b.authorizeGrant(req); !ok {
		t.Fatal("another epoch revoked active grant")
	}
	identity := map[string]string{"instance_id": g.InstanceID, "epoch": g.Epoch}
	for i := 0; i < 2; i++ {
		if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, identity); status != 200 {
			t.Fatal(status)
		}
	}
	if _, ok := b.authorizeGrant(req); ok {
		t.Fatal("identity revoke left active grant")
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, map[string]string{"grant": g.Grant, "instance_id": g.InstanceID, "epoch": g.Epoch}); status != 400 {
		t.Fatalf("ambiguous revoke %d", status)
	}
	if status, _ := grantRequest(t, srv.URL, http.MethodDelete, bridgeControl, map[string]any{"grant": g.Grant, "instance_id": nil}); status != 400 {
		t.Fatalf("null fields bypassed strict union %d", status)
	}
}

func TestBridgeAppRedirectCannotLeakHostCredentials(t *testing.T) {
	var leaked int
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer sink.Close()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
	}))
	defer app.Close()
	// Even a supplied client that permits redirect must be hardened by postData.
	b := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl, HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return nil }}})
	srv := httptest.NewServer(b.Handler())
	defer srv.Close()
	g := testGrant()
	if status, _ := grantRequest(t, srv.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatal(status)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+g.Grant)
	grant, ok := b.authorizeGrant(req)
	if !ok {
		t.Fatal("grant missing")
	}
	if _, err := b.postData(context.Background(), grant, "tool_start", map[string]any{}); err == nil {
		t.Fatal("redirect accepted")
	}
	if leaked != 0 {
		t.Fatalf("redirect leaked credentials in %d requests", leaked)
	}
}
