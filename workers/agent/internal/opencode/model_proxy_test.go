package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type proxyFixture struct {
	server       *httptest.Server
	grant        Grant
	mu           sync.Mutex
	receipts     []map[string]any
	sends        int
	disposition  string
	failComplete bool
	upstream     func(http.ResponseWriter, *http.Request)
}

func newProxyFixture(t *testing.T, modelTimeout ...time.Duration) *proxyFixture {
	t.Helper()
	f := &proxyFixture{grant: testGrant(), disposition: "send_once"}
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		params := body["params"].(map[string]any)
		f.mu.Lock()
		f.receipts = append(f.receipts, params)
		disposition := f.disposition
		failed := f.failComplete && params["phase"] == "completed"
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failed {
			w.WriteHeader(503)
			return
		}
		if params["phase"] != "started" {
			disposition = params["phase"].(string)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "disposition": disposition})
	}))
	t.Cleanup(app.Close)
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.sends++
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer vendor-secret" || r.Header.Get("X-Secret") != "" || r.URL.Path != "/v1/chat/completions" {
			t.Error("untrusted headers or path")
		}
		f.upstream(w, r)
	}))
	t.Cleanup(vendor.Close)
	bridge := NewBridge(BridgeConfig{AppDataURL: app.URL, AppServiceToken: "app-secret", ControlToken: bridgeControl, AllowedModel: "research-fixed"})
	mux := http.NewServeMux()
	timeout := time.Duration(0)
	if len(modelTimeout) > 0 {
		timeout = modelTimeout[0]
	}
	mux.Handle("/v1/chat/completions", NewModelProxy(bridge, ModelProxyConfig{BaseURL: vendor.URL + "/v1", APIKey: "vendor-secret", ModelName: "research-fixed", ModelTimeout: timeout}))
	mux.Handle("/", bridge.Handler())
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	if status, _ := grantRequest(t, f.server.URL, http.MethodPost, bridgeControl, f.grant); status != 201 {
		t.Fatalf("register %d", status)
	}
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"安全"}}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}`)
	}
	return f
}

func (f *proxyFixture) request(t *testing.T, body, path, grant string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.server.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+grant)
	req.Header.Set("X-Secret", "caller-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw)
}

const modelBody = `{"model":"research-fixed","messages":[{"role":"user","content":"材料 <>& 中文"}]}`

func TestModelProxyActualSendAndStableReceipt(t *testing.T) {
	f := newProxyFixture(t)
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["max_tokens"] != float64(1800) {
			t.Errorf("max %v", body["max_tokens"])
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"usage":{"prompt_tokens":3,"completion_tokens":1}}`)
	}
	status, raw := f.request(t, modelBody, "/v1/chat/completions", f.grant.Grant)
	if status != 200 || strings.Contains(raw, "secret") || f.sends != 1 || len(f.receipts) != 2 {
		t.Fatalf("%d %s sends=%d receipts=%v", status, raw, f.sends, f.receipts)
	}
	a, b := f.receipts[0], f.receipts[1]
	if a["call_id"] != b["call_id"] || a["request_digest"] != b["request_digest"] || b["input_tokens"] != float64(3) || b["output_tokens"] != float64(1) {
		t.Fatalf("receipts %v", f.receipts)
	}
	for _, disposition := range []string{"already_started", "completed", "unknown", "denied", ""} {
		f.disposition = disposition
		status, _ = f.request(t, modelBody, "/v1/chat/completions", f.grant.Grant)
		if status != 409 || f.sends != 1 {
			t.Fatalf("replayed %s sends=%d", disposition, f.sends)
		}
	}
}

func TestModelProxyRejectsUntrustedRequestBeforeSend(t *testing.T) {
	f := newProxyFixture(t)
	for _, body := range []string{`{"model":"other","messages":[]}`, strings.Replace(modelBody, "}", `,"url":"https://evil"}`, 1), strings.Replace(modelBody, "}", `,"max_tokens":1801}`, 1), `{"model":"research-fixed","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://evil"}}]}]}`, strings.Repeat("x", modelRequestLimit+1)} {
		status, _ := f.request(t, body, "/v1/chat/completions", f.grant.Grant)
		if status != 400 && status != 413 {
			t.Fatalf("accepted request %d", status)
		}
	}
	for _, path := range []string{"/v1/chat/completions?url=http://evil", "/v1/chat/completions/other"} {
		status, _ := f.request(t, modelBody, path, f.grant.Grant)
		if status == 200 {
			t.Fatal("accepted route")
		}
	}
	status, _ := f.request(t, modelBody, "/v1/chat/completions", "foreign")
	if status != 401 || f.sends != 0 || len(f.receipts) != 0 {
		t.Fatal("invalid grant sent model")
	}
}

func TestModelProxySSEFragmentsMultilineAndUsage(t *testing.T) {
	f := newProxyFixture(t)
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream_options"].(map[string]any)["include_usage"] != true {
			t.Error("missing usage request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		raw := "data: {\"choices\":[{\"delta\":{\"content\":\"中文😀\"}}]}\n\ndata: {\"choices\":[],\ndata: \"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n"
		for _, b := range []byte(raw) {
			w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}
	body := strings.TrimSuffix(modelBody, "}") + `,"stream":true,"stream_options":{"include_usage":false}}`
	status, raw := f.request(t, body, "/v1/chat/completions", f.grant.Grant)
	if status != 200 || !strings.Contains(raw, "中文😀") || !strings.HasSuffix(raw, "data: [DONE]\n\n") || strings.Contains(raw, "outcome_unknown") || len(f.receipts) != 2 {
		t.Fatalf("%d %s %v", status, raw, f.receipts)
	}
}

func TestModelProxyUnknownOnStreamOrReceiptFailure(t *testing.T) {
	for _, mode := range []string{"missing_usage", "disconnect", "over_limit", "supplier_failure", "receipt_failure", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			f := newProxyFixture(t)
			stream := mode != "supplier_failure" && mode != "receipt_failure" && mode != "redirect"
			f.failComplete = mode == "receipt_failure"
			f.upstream = func(w http.ResponseWriter, r *http.Request) {
				if mode == "supplier_failure" {
					w.WriteHeader(500)
					io.WriteString(w, "vendor-secret")
					return
				}
				if mode == "redirect" {
					w.Header().Set("Location", "http://localhost:1/leak")
					w.WriteHeader(307)
					return
				}
				if !stream {
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"usage":{"prompt_tokens":5,"completion_tokens":2}}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "data: {\"choices\":[]}\n\n")
				if mode == "over_limit" {
					io.WriteString(w, "data: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":1801}}\n\n")
				}
				if mode != "disconnect" {
					io.WriteString(w, "data: [DONE]\n\n")
				}
			}
			body := modelBody
			if stream {
				body = strings.TrimSuffix(body, "}") + `,"stream":true}`
			}
			_, raw := f.request(t, body, "/v1/chat/completions", f.grant.Grant)
			if !strings.Contains(raw, "model_outcome_unknown") || strings.Contains(raw, "[DONE]") || strings.Contains(raw, "vendor-secret") || f.sends != 1 || f.receipts[len(f.receipts)-1]["phase"] != "unknown" {
				t.Fatalf("%s receipts %v", raw, f.receipts)
			}
		})
	}
}

func TestModelProxyCancellationStillRecordsUnknown(t *testing.T) {
	f := newProxyFixture(t)
	started := make(chan struct{})
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}
	req, _ := http.NewRequest(http.MethodPost, f.server.URL+"/v1/chat/completions", strings.NewReader(modelBody))
	req.Header.Set("Authorization", "Bearer "+f.grant.Grant)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		res, _ := http.DefaultClient.Do(req)
		if res != nil {
			res.Body.Close()
		}
	}()
	<-started
	cancel()
	<-finished
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		ok := len(f.receipts) > 1 && f.receipts[len(f.receipts)-1]["phase"] == "unknown"
		f.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancel omitted unknown receipt")
}

func TestModelProxyAcceptsActualLockedSDKRequestShape(t *testing.T) {
	raw, err := os.ReadFile("../../../../validation/agent/opencode/protocol.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		ModelRequests []struct {
			Body map[string]any `json:"body"`
		} `json:"modelRequests"`
	}
	if json.Unmarshal(raw, &fixture) != nil || len(fixture.ModelRequests) == 0 {
		t.Fatal("fixture missing")
	}
	g := testGrant()
	g.Model = "fixture"
	g.MaxOutputTokensPerCall = 4096
	for _, request := range fixture.ModelRequests {
		body, _ := json.Marshal(request.Body)
		if _, _, err := validateModelBody(body, g); err != nil {
			t.Fatalf("real SDK shape: %v", err)
		}
	}
	if _, err := relayModelStream(httptest.NewRecorder(), strings.NewReader("data: {}\n\ndata: [DONE]\n\n"), 10); err == nil {
		t.Fatal("missing usage accepted")
	}
}

func TestModelProxyExpiredGrantAndBoundedResponse(t *testing.T) {
	f := newProxyFixture(t)
	g := testGrant()
	g.Grant = strings.Repeat("z", 32)
	g.ExpiresAt = time.Now().Add(25 * time.Millisecond)
	if status, _ := grantRequest(t, f.server.URL, http.MethodPost, bridgeControl, g); status != 201 {
		t.Fatalf("register %d", status)
	}
	time.Sleep(30 * time.Millisecond)
	if status, _ := f.request(t, modelBody, "/v1/chat/completions", g.Grant); status != 401 || f.sends != 0 {
		t.Fatal("expired grant sent request")
	}
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, strings.Repeat("x", modelResponseLimit+1))
	}
	status, raw := f.request(t, modelBody, "/v1/chat/completions", f.grant.Grant)
	if status != 502 || !strings.Contains(raw, "model_outcome_unknown") || f.receipts[len(f.receipts)-1]["phase"] != "unknown" {
		t.Fatalf("unbounded response %d %s", status, raw)
	}
	for _, raw := range []string{`{"prompt_tokens":-1,"completion_tokens":1}`, `{"prompt_tokens":1.1,"completion_tokens":1}`, `{"prompt_tokens":1,"completion_tokens":1801}`, `{"prompt_tokens":1,"completion_tokens":1,"total_tokens":99}`} {
		if _, err := modelUsage([]byte(raw), 1800); err == nil {
			t.Fatal("invalid usage accepted")
		}
	}
}

func TestModelProxyRevocationCancelsActiveSupplier(t *testing.T) {
	f := newProxyFixture(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}
	finished := make(chan string, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodPost, f.server.URL+"/v1/chat/completions", strings.NewReader(modelBody))
		req.Header.Set("Authorization", "Bearer "+f.grant.Grant)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			finished <- err.Error()
			return
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		finished <- string(raw)
	}()
	<-started
	if status, _ := grantRequest(t, f.server.URL, http.MethodDelete, bridgeControl, map[string]string{"grant": f.grant.Grant}); status != 200 {
		t.Fatalf("revoke %d", status)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("revoked supplier kept running")
	}
	if raw := <-finished; !strings.Contains(raw, "model_outcome_unknown") {
		t.Fatal("revocation claimed success")
	}
}

func TestModelProxyRedirectNeverReachesSecondHost(t *testing.T) {
	f := newProxyFixture(t)
	var mu sync.Mutex
	leaked := 0
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		leaked++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}))
	defer second.Close()
	f.upstream = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", second.URL+"/v1/chat/completions")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}
	status, raw := f.request(t, modelBody, "/v1/chat/completions", f.grant.Grant)
	mu.Lock()
	defer mu.Unlock()
	if status != 502 || leaked != 0 || strings.Contains(raw, "vendor-secret") {
		t.Fatalf("redirect leak status=%d count=%d", status, leaked)
	}
}

func TestModelProxyModelTimeoutStillRecordsUnknown(t *testing.T) {
	f := newProxyFixture(t, 25*time.Millisecond)
	f.upstream = func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }
	start := time.Now()
	status, raw := f.request(t, modelBody, "/v1/chat/completions", f.grant.Grant)
	if status != 502 || !strings.Contains(raw, "model_outcome_unknown") || time.Since(start) > time.Second || f.receipts[len(f.receipts)-1]["phase"] != "unknown" {
		t.Fatalf("timeout %d %s receipts %v", status, raw, f.receipts)
	}
}

// Vendor reasoning_content (deepseek) echoed on follow-up turns must be
// stripped, not rejected — otherwise multi-turn tool use always 400s.
func TestValidateModelBodyStripsReasoningContent(t *testing.T) {
	body := `{"model":"m1","max_tokens":10,"messages":[
		{"role":"system","content":"s"},
		{"role":"assistant","content":"","reasoning_content":"thinking...","tool_calls":[{"id":"call_1","type":"function","function":{"name":"corpus_list_keywords","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"{}"}]}`
	g := Grant{Model: "m1", MaxOutputTokensPerCall: 1800}
	out, _, err := validateModelBody([]byte(body), g)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	msgs := out["messages"].([]any)
	if _, exists := msgs[1].(map[string]any)["reasoning_content"]; exists {
		t.Fatalf("reasoning_content not stripped")
	}
}
