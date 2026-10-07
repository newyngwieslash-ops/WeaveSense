package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"loom.local/agent/internal/agent"
)

type workerTransportFunc func(*http.Request) (*http.Response, error)

func (f workerTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLostDispatchACKNeverResendsAndStopsBeforeCompletion(t *testing.T) {
	cfg, calls := workerFixture(t, "producer", false)
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		var raw []byte
		if req.Body != nil {
			raw, _ = io.ReadAll(req.Body)
		}
		req.Body = io.NopCloser(bytes.NewReader(raw))
		res, err := http.DefaultTransport.RoundTrip(req)
		if strings.Contains(string(raw), "prompt_async") && err == nil {
			res.Body.Close()
			return nil, errors.New("lost dispatch ACK")
		}
		return res, err
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	prompts, final := 0, 0
	for _, c := range *calls {
		if strings.Contains(c, "prompt_async") {
			prompts++
		}
		if c == "POST:finalize" {
			final++
		}
	}
	if prompts != 1 || final != 0 {
		t.Fatal(*calls)
	}
}

func TestHeartbeatCancellationRevokesGrantAndConfirmsStop(t *testing.T) {
	cfg, calls := workerFixture(t, "producer", false)
	cfg.HeartbeatInterval = 10 * time.Millisecond
	cfg.PollInterval = time.Millisecond
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		var raw []byte
		if req.Body != nil {
			raw, _ = io.ReadAll(req.Body)
		}
		req.Body = io.NopCloser(bytes.NewReader(raw))
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			return res, err
		}
		if strings.Contains(string(raw), `"action":"renew"`) {
			res.Body.Close()
			res.Body = io.NopCloser(strings.NewReader(`{"ok":true,"cancel_requested":true}`))
		}
		if strings.Contains(string(raw), `"path":"/session/ses_A/message"`) {
			res.Body.Close()
			res.Body = io.NopCloser(strings.NewReader(`[]`))
		}
		return res, nil
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	revoked, stopped, final := false, false, false
	for _, c := range *calls {
		if c == "DELETE:/v1/grants" {
			revoked = true
		}
		if c == "POST:/stop" {
			stopped = true
		}
		if c == "POST:finalize" {
			final = true
		}
	}
	if !revoked || !stopped || final {
		t.Fatal(*calls)
	}
}

func TestLostStopACKReplaysIdentityWithoutNewDispatch(t *testing.T) {
	cfg, calls := workerFixture(t, "producer", false)
	stops := 0
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		res, err := http.DefaultTransport.RoundTrip(req)
		if req.URL.Path == "/stop" && err == nil {
			stops++
			if stops == 1 {
				res.Body.Close()
				return nil, errors.New("lost stop ACK")
			}
		}
		return res, err
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if stops != 2 {
		t.Fatal(*calls)
	}
}

func TestActualTSProfileWithPriceVersionAndOffModeBudget(t *testing.T) {
	cfg, calls := workerFixture(t, "producer", false)
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		var raw []byte
		if req.Body != nil {
			raw, _ = io.ReadAll(req.Body)
		}
		req.Body = io.NopCloser(bytes.NewReader(raw))
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			return res, err
		}
		if strings.Contains(string(raw), `"action":"claim"`) {
			data, _ := io.ReadAll(res.Body)
			res.Body.Close()
			var actual map[string]any
			_ = json.Unmarshal(data, &actual)
			// Match the host's actual TS object, including the field Go marshal formerly omitted.
			actual["model_profile"] = map[string]any{"model": "model", "input_per_million": 0.15, "output_per_million": 0.6, "price_version": "supplier-2026-10"}
			actual["producer_model_calls"] = 6
			actual["policy"].(map[string]any)["max_model_calls"] = 6
			data, _ = json.Marshal(actual)
			res.Body = io.NopCloser(bytes.NewReader(data))
		}
		return res, nil
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, c := range *calls {
		if strings.Contains(c, "prompt_async") {
			seen = true
		}
	}
	if !seen {
		t.Fatal(*calls)
	}
}

func TestReconcileRejectsOtherRunBindingBeforeRuntimeRead(t *testing.T) {
	cfg, calls := workerFixture(t, "reconcile", false)
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		var body []byte
		if req.Body != nil {
			body, _ = io.ReadAll(req.Body)
		}
		req.Body = io.NopCloser(bytes.NewReader(body))
		res, err := http.DefaultTransport.RoundTrip(req)
		if err == nil && strings.Contains(string(body), `"action":"claim"`) {
			raw, _ := io.ReadAll(res.Body)
			res.Body.Close()
			var claim map[string]any
			_ = json.Unmarshal(raw, &claim)
			claim["runtime_binding"].(map[string]any)["run_id"] = "00000000-0000-4000-8000-000000000009"
			raw, _ = json.Marshal(claim)
			res.Body = io.NopCloser(bytes.NewReader(raw))
		}
		return res, err
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	for _, c := range *calls {
		if c == "GET:/status" || strings.Contains(c, "/session/") {
			t.Fatal(*calls)
		}
	}
}

func TestReviewUsesTrustedHTTPOnceAndCannotDispatchProducer(t *testing.T) {
	cfg, calls := workerFixture(t, "review", false)
	id := "00000000-0000-4000-8000-000000000001"
	candidate := json.RawMessage(`{"content":"Report","citations":[],"coverage":"partial","insufficient_evidence":true,"warnings":[]}`)
	policy := map[string]any{"question": "Research cotton", "version": "loom-v1", "model": "model", "max_output_tokens_per_call": 1800}
	policyRaw, _ := json.Marshal(policy)
	r := agent.ReviewRequest{SchemaVersion: 1, RunID: id, ReviewCallID: id, ReviewerGrant: "opaque-review-grant-fixture", Question: "Research cotton", Candidate: candidate, Evidence: []json.RawMessage{}, Policy: policyRaw, DeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}
	var parsedCandidate map[string]any
	_ = json.Unmarshal(candidate, &parsedCandidate)
	r.CandidateDigest, _ = canonicalHash(parsedCandidate)
	r.EvidenceDigest, _ = canonicalHash([]any{})
	r.PolicyDigest, _ = canonicalHash(policy)
	r.RequestDigest, _ = canonicalHash(map[string]any{"role": "reviewer", "run_id": id, "review_call_id": id, "question": r.Question, "candidate_digest": r.CandidateDigest, "evidence_digest": r.EvidenceDigest, "policy_digest": r.PolicyDigest, "model": "model", "policy_version": "loom-v1", "deadline_at": r.DeadlineAt})
	raw, _ := json.Marshal(r)
	if _, err := agent.ParseReviewRequest(raw); err != nil {
		t.Fatal(err)
	}
	report := agent.ReviewReport{SchemaVersion: 1, RunID: id, CandidateDigest: r.CandidateDigest, EvidenceDigest: r.EvidenceDigest, PolicyDigest: r.PolicyDigest, Findings: []agent.ReviewFinding{}}
	for _, name := range []string{"support", "scope", "conflicts", "source_independence", "uncertainty"} {
		report.Checks = append(report.Checks, agent.ReviewCheck{ID: name, Status: "pass"})
	}
	reviews := 0
	cfg.HTTPTransport = workerTransportFunc(func(req *http.Request) (*http.Response, error) {
		var body []byte
		if req.Body != nil {
			body, _ = io.ReadAll(req.Body)
		}
		req.Body = io.NopCloser(bytes.NewReader(body))
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			return res, err
		}
		var replacement []byte
		if strings.Contains(string(body), `"action":"review_start"`) {
			replacement, _ = json.Marshal(map[string]any{"ok": true, "request": r})
		}
		if req.URL.Path == "/review" {
			reviews++
			if req.Header.Get("Authorization") != "Bearer "+cfg.ReviewServiceToken {
				t.Error("wrong reviewer service credential")
			}
			replacement, _ = json.Marshal(agent.ReviewResponse{SchemaVersion: 1, RunID: id, OK: true, Report: &report})
		}
		if replacement != nil {
			res.Body.Close()
			res.Body = io.NopCloser(bytes.NewReader(replacement))
		}
		return res, nil
	})
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if reviews != 1 {
		t.Fatal(reviews)
	}
	saved := false
	for _, c := range *calls {
		if c == "POST:review_result" {
			saved = true
		}
		if strings.Contains(c, "prompt_async") {
			t.Fatal(*calls)
		}
	}
	if !saved {
		t.Fatal(*calls)
	}
}

func workerFixture(t *testing.T, phase string, candidateLost bool) (WorkerConfig, *[]string) {
	t.Helper()
	var mu sync.Mutex
	calls := []string{}
	claimed := false
	candidates := 0
	id := "00000000-0000-4000-8000-000000000001"
	epoch := "00000000-0000-4000-8000-000000000002"
	digest := strings.Repeat("a", 64)
	state := RuntimeState{Binding: Binding{InstanceID: id, Epoch: epoch}, RunID: id, Version: RuntimeVersion, Status: "prepared", DispatchState: "prepared", ConfigDigest: digest, SkillSnapshotDigest: digest, SkillVersions: map[string]string{"briefing-writing": digest, "industry-analysis": digest, "cross-source-check": digest}}
	claim := Claim{JobID: id, RunID: id, ClaimToken: id, DataAccessToken: "opaque-data-grant-fixture", Governed: true, Phase: phase, RuntimeVersion: RuntimeVersion, SkillSnapshotDigest: digest, ProducerDeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339), ProducerModelCalls: 2, ModelProfile: ModelProfile{Model: "model"}}
	claim.Mode = "research"
	claim.Input.Question = "Research cotton"
	claim.Policy.Version = "loom-v1"
	claim.Policy.DeadlineAt = time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339)
	claim.Policy.MaxModelCalls = 3
	claim.Policy.MaxToolCalls = 2
	claim.Policy.MaxOutputTokensPerCall = 1800
	if phase == "reconcile" {
		claim.RuntimeBinding = &SavedBinding{Binding: Binding{InstanceID: id, Epoch: epoch, SessionID: "ses_A"}, RunID: id, Provider: "opencode", DispatchID: id, RuntimeVersion: RuntimeVersion, ConfigDigest: digest, State: "dispatch_unknown"}
		state.SessionID = "ses_A"
		state.Status = "running"
		state.ProcessRunning = true
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tag := r.URL.Path
		if r.URL.Path == "/jobs" {
			tag = body["action"].(string)
		}
		if r.URL.Path == "/forward" {
			tag = body["path"].(string)
		}
		calls = append(calls, r.Method+":"+tag)
		switch tag {
		case "claim":
			if claimed {
				w.WriteHeader(204)
				return
			}
			claimed = true
			_ = json.NewEncoder(w).Encode(claim)
		case "/health":
			_ = json.NewEncoder(w).Encode(map[string]any{"healthy": true, "version": RuntimeVersion})
		case "/prepare":
			_ = json.NewEncoder(w).Encode(state)
		case "/status":
			_ = json.NewEncoder(w).Encode(state)
		case "/start":
			state.Status = "running"
			state.ProcessRunning = true
			_ = json.NewEncoder(w).Encode(state)
		case "/session":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "ses_A"})
		case "/session/ses_A/prompt_async":
			w.WriteHeader(204)
		case "/session/ses_A/message":
			_, _ = w.Write([]byte(`[{"info":{"id":"msg_A","sessionID":"ses_A","role":"assistant","agent":"research","providerID":"bridge","modelID":"model","finish":"stop","time":{"completed":1}},"parts":[{"type":"text","sessionID":"ses_A","messageID":"msg_A","text":"{\"content\":\"Report\",\"citations\":[],\"coverage\":\"partial\",\"insufficient_evidence\":true,\"warnings\":[]}"}]}]`))
		case "/session/ses_A/abort":
			_, _ = w.Write([]byte(`true`))
		case "/stop":
			state.Status = "stopped"
			state.Stopped = true
			state.ProcessRunning = false
			_ = json.NewEncoder(w).Encode(state)
		case "candidate":
			candidates++
			if candidateLost && candidates == 1 {
				w.WriteHeader(500)
				_, _ = w.Write([]byte(`{"error":"lost"}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "review_start":
			_, _ = w.Write([]byte(`{"ok":true,"skip":true}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(s.Close)
	cfg := WorkerConfig{JobsURL: s.URL + "/jobs", WorkerToken: "opaque-worker-token-fixture", RuntimeURL: s.URL, RuntimeToken: "opaque-runtime-token-fixture", BridgeURL: s.URL, BridgeControlToken: "opaque-bridge-token-fixture", ReviewURL: s.URL + "/review", ReviewServiceToken: "opaque-review-token-fixture", ModelName: "model", PollInterval: time.Millisecond}
	return cfg, &calls
}

func TestProducerDispatchOnceAndCandidateACKReplay(t *testing.T) {
	cfg, calls := workerFixture(t, "producer", true)
	if err := RunWorkerOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	count := map[string]int{}
	for _, c := range *calls {
		count[c]++
	}
	if count["POST:/session/ses_A/prompt_async"] != 1 || count["POST:candidate"] != 2 || count["POST:finalize"] != 1 {
		t.Fatal(*calls)
	}
	index := func(s string) int {
		for i, c := range *calls {
			if c == s {
				return i
			}
		}
		return -1
	}
	if !(index("POST:bind") < index("POST:dispatching") && index("POST:dispatching") < index("POST:/session/ses_A/prompt_async") && index("DELETE:/v1/grants") < index("POST:/stop")) {
		t.Fatal(*calls)
	}
}
func TestRecoveryNeverDispatchesNewSessionOrPrompt(t *testing.T) {
	for _, phase := range []string{"reconcile", "review", "finalize"} {
		t.Run(phase, func(t *testing.T) {
			cfg, calls := workerFixture(t, phase, false)
			if err := RunWorkerOnce(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			for _, c := range *calls {
				if c == "POST:/prepare" || c == "POST:/start" || c == "POST:/session" || strings.Contains(c, "prompt_async") || c == "POST:/v1/grants" {
					t.Fatal(*calls)
				}
			}
			if phase == "reconcile" {
				candidate := false
				for _, c := range *calls {
					if c == "POST:candidate" {
						candidate = true
					}
				}
				if !candidate {
					t.Fatal("bound terminal was not reconciled", *calls)
				}
			}
		})
	}
}
