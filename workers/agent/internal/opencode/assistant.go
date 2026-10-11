package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync/atomic"
	"time"

	"loom.local/agent/internal/agent"
)

// Assistant worker execution (plan Task 10 / §4.2–§4.4).
//
// RunAssistantWorkerOnce mirrors RunWorkerOnce for job_kind='assistant'
// claims but diverges where the products differ: no candidate, no reviewer,
// and the terminal payload is the AssistantResult contract decoded by
// AssistantTerminalResult and submitted via the assistant_result action.
// The claim parser is separate from the research one so a research claim can
// never be executed as an assistant run and vice versa. Recovery observes the
// saved binding without ever re-prompting.

func RunAssistantWorkerOnce(parent context.Context, cfg WorkerConfig) (runErr error) {
	if err := validateWorkerConfig(cfg); err != nil {
		return err
	}
	raw, status, err := workerHTTP(parent, cfg, "POST", cfg.JobsURL, cfg.WorkerToken, []byte(`{"action":"assistant_claim"}`), agent.MaxRequestBytes)
	if err == nil && (status == 204 || status == 404) {
		return nil
	}
	if err != nil || status != 200 {
		return errors.New("assistant_claim_unavailable")
	}
	var claim Claim
	if strictJSON(raw, &claim) != nil || !canonicalUUID(claim.JobID) || !canonicalUUID(claim.RunID) || !canonicalUUID(claim.ClaimToken) ||
		!claim.Governed || claim.Mode != agent.ModeResearch || claim.Profile != "assistant" || claim.RuntimeVersion != RuntimeVersion ||
		claim.ModelProfile.Model != cfg.ModelName || !digestRE.MatchString(claim.SkillSnapshotDigest) {
		return errors.New("invalid_assistant_claim")
	}
	if err := agent.ValidateRequest(agent.ExecuteRequest{SchemaVersion: 1, RunID: claim.RunID, Mode: claim.Mode, Input: agent.ExecuteInput{Question: "assistant"}, Policy: claim.Policy}); err != nil {
		return errors.New("invalid_assistant_policy")
	}
	if claim.Phase != "producer" && claim.Phase != "reconcile" {
		return errors.New("invalid_assistant_phase")
	}
	deadline, err := time.Parse(time.RFC3339, claim.Policy.DeadlineAt)
	if err != nil || !deadline.After(time.Now()) {
		return errors.New("invalid_claim_deadline")
	}
	runCtx, endRun := context.WithDeadline(parent, deadline)
	execCtx, endExec := context.WithCancel(runCtx)
	var cancelled atomic.Bool
	done := make(chan struct{})
	defer func() { endExec(); endRun(); <-done }()
	go func() {
		defer close(done)
		interval := cfg.HeartbeatInterval
		if interval <= 0 {
			interval = 5 * time.Second
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				body, _ := json.Marshal(jobEnvelope(claim, "renew"))
				hbRaw, hbStatus, e := workerHTTP(runCtx, cfg, "POST", cfg.JobsURL, cfg.WorkerToken, body, 4096)
				var ack struct {
					OK     bool `json:"ok"`
					Cancel bool `json:"cancel_requested"`
				}
				if e != nil || hbStatus != 200 || json.Unmarshal(hbRaw, &ack) != nil || !ack.OK {
					cancelled.Store(true)
					endExec()
					return
				}
				if ack.Cancel {
					cancelled.Store(true)
					endExec()
					return
				}
			}
		}
	}()

	post := func(action string, extra map[string]any) (json.RawMessage, error) {
		body := jobEnvelope(claim, action)
		for key, value := range extra {
			body[key] = value
		}
		payload, _ := json.Marshal(body)
		raw, status, err := workerHTTP(execCtx, cfg, "POST", cfg.JobsURL, cfg.WorkerToken, payload, agent.MaxResponseBytes)
		if err != nil {
			return nil, err
		}
		if status != 200 {
			// Surface which host action was denied and its status so
			// operators can distinguish config drift from state conflicts.
			return nil, fmt.Errorf("job_action_denied: %s -> %d", action, status)
		}
		return raw, nil
	}
	complete := func(code string, unknown bool) error {
		extra := map[string]any{"status": "failed", "error_code": code, "outcome_unknown": unknown}
		_, err := post("assistant_result", extra)
		return err
	}
	var grant string
	var binding Binding
	var skillVersions map[string]string
	cleanup := func() error {
		if !validBinding(binding) {
			return nil
		}
		if _, _, err := runtimeRequest(execCtx, cfg, "POST", "/forward", map[string]any{"instance_id": binding.InstanceID, "epoch": binding.Epoch, "method": "POST", "path": "/session/" + binding.SessionID + "/abort", "body": map[string]any{}}); err != nil {
			return errors.New("runtime_abort_failed")
		}
		if _, _, err := runtimeRequest(execCtx, cfg, "POST", "/stop", map[string]any{"instance_id": binding.InstanceID, "epoch": binding.Epoch}); err != nil {
			return errors.New("runtime_stop_failed")
		}
		if err := workerBridgeControl(execCtx, cfg, "DELETE", map[string]string{"instance_id": binding.InstanceID, "epoch": binding.Epoch}); err != nil {
			return errors.New("grant_revoke_failed")
		}
		binding = Binding{}
		return nil
	}
	defer func() {
		if validBinding(binding) {
			if err := cleanup(); err != nil {
				runErr = err
			}
		}
	}()

	if claim.Phase == "producer" || claim.Phase == "reconcile" {
		failNow := func(code string, unknown bool) error {
			if unknown {
				_, _ = post("dispatch_unknown", map[string]any{"error_code": code})
			}
			if err := cleanup(); err != nil {
				return err
			}
			return complete(code, unknown)
		}
		producerCtx := execCtx
		var cancelProducer context.CancelFunc = func() {}
		defer cancelProducer()
		if claim.Phase == "producer" {
			if claim.Resume || claim.RuntimeBinding != nil {
				return complete("unsafe_assistant_resume", true)
			}
			producerDeadline, e := time.Parse(time.RFC3339, claim.ProducerDeadlineAt)
			// The output cap is policy-driven (host env, 200..4000); the
			// worker only rejects out-of-band values so a drifted host can
			// never widen the budget beyond the admitted reservation.
			if e != nil || !producerDeadline.After(time.Now()) || producerDeadline.After(deadline) || claim.ProducerModelCalls < 1 || claim.ProducerModelCalls > claim.Policy.MaxModelCalls || claim.Policy.MaxOutputTokensPerCall < 200 || claim.Policy.MaxOutputTokensPerCall > 4000 {
				return complete("invalid_assistant_policy", false)
			}
			producerCtx, cancelProducer = context.WithDeadline(execCtx, producerDeadline)
			defer cancelProducer()
			if err := clientHealth(producerCtx, cfg); err != nil {
				return complete("runtime_unavailable", false)
			}
			secret := make([]byte, 32)
			if _, err := rand.Read(secret); err != nil {
				return err
			}
			grant = hex.EncodeToString(secret)
			client := func() *Client { c, _ := NewClient(cfg.RuntimeURL, cfg.RuntimeToken, cfg.HTTPTransport); return c }()
			prepared, e := client.PrepareProfile(producerCtx, claim.RunID, grant, claim.ClaimToken, "assistant")
			if validBinding(prepared.Binding) {
				binding = prepared.Binding
			}
			if e != nil {
				return failNow("runtime_prepare_failed", false)
			}
			skillVersions = prepared.SkillVersions
			if _, ok := skillVersions["project-assistant"]; !ok || len(skillVersions) != 1 {
				return failNow("runtime_snapshot_mismatch", false)
			}
			if prepared.SkillSnapshotDigest != claim.SkillSnapshotDigest {
				return failNow("runtime_snapshot_mismatch", false)
			}
			auth := Grant{Grant: grant, RunID: claim.RunID, ClaimToken: claim.ClaimToken, InstanceID: binding.InstanceID, Epoch: binding.Epoch, ExpiresAt: producerDeadline, DataAccessToken: claim.DataAccessToken, Model: claim.ModelProfile.Model, PolicyVersion: claim.Policy.Version, MaxOutputTokensPerCall: claim.Policy.MaxOutputTokensPerCall, Profile: "assistant"}
			if err := workerBridgeControl(producerCtx, cfg, "POST", auth); err != nil {
				return failNow("bridge_register_failed", false)
			}
			started, e := client.Start(producerCtx, binding)
			if e != nil || started.Status != "running" || !started.ProcessRunning {
				return failNow("runtime_start_failed", false)
			}
			session, e := client.Session(producerCtx, binding)
			if e != nil {
				return failNow("runtime_session_failed", false)
			}
			binding.SessionID = session
			if _, e = post("bind", map[string]any{"instance_id": binding.InstanceID, "epoch": binding.Epoch, "session_id": session, "runtime_version": RuntimeVersion, "config_digest": prepared.ConfigDigest, "profile": "assistant"}); e != nil {
				return failNow("runtime_bind_denied", false)
			}
			if _, e = post("dispatching", nil); e != nil {
				return failNow("runtime_dispatch_denied", true)
			}
			// The operator's message is the task. The contract preamble sets
			// the output shape; the question itself goes LAST so the model
			// answers THIS turn's request instead of reciting a canned
			// status survey (the answer contract still constrains it).
			contract := `You are the read-only project assistant. Gather data ONLY with the host read tools, and only when the request below needs data. corpus_search_items with NO query returns the most recently collected items (with body snippets); corpus_get_item reads one item's full body by a returned item_id — use them for any "recent/last collected content" request instead of claiming item content is unreadable. Propose every write as a structured action in your final JSON. Return exactly one AssistantResult JSON object: version 1, answer string (at most 800 characters — a truncated JSON fails validation), citations:[{kind,id}] (at most 12; kind MUST be one of exactly: item|source|keyword|note|collection_job|research_job), actions:[{ordinal,kind,args}] (at most 4; ordinal from 0; ONLY these kinds: keyword.create|keyword.update|keyword.set_enabled|keyword.collect_once|source.create|source.set_enabled|source.collect_once|research.start|research.cancel — never invent a kind; if the need has no kind, use clarification instead), optional clarification{question,options:[...]} (mutually exclusive with actions). No Markdown fences, shell, or extra keys. Answer in the operator's language. Now the operator's request: `
			request := strings.TrimSpace(claim.Question)
			if request == "" {
				// Defensive: an empty question degrades to the generic
				// survey rather than dispatching a bare contract.
				request = "请报告当前项目状态概览。"
			}
			prompt := contract + request
			if e = client.Prompt(producerCtx, binding, prompt); e != nil {
				return failNow("runtime_dispatch_unknown", true)
			}
			if _, e = post("submitted", nil); e != nil {
				return failNow("runtime_submit_ack_unknown", true)
			}
		} else {
			saved := claim.RuntimeBinding
			if saved == nil || saved.RunID != claim.RunID || saved.Provider != "opencode" || !canonicalUUID(saved.DispatchID) || saved.RuntimeVersion != RuntimeVersion || !validBinding(saved.Binding) || !sessionRE.MatchString(saved.SessionID) || !digestRE.MatchString(saved.ConfigDigest) || saved.State != "submitted" && saved.State != "dispatch_unknown" {
				return complete("runtime_recovery_unsafe", true)
			}
			binding = saved.Binding
			client := func() *Client { c, _ := NewClient(cfg.RuntimeURL, cfg.RuntimeToken, cfg.HTTPTransport); return c }()
			observed, e := client.Status(execCtx, binding)
			if e != nil || observed.Version != saved.RuntimeVersion || observed.ConfigDigest != saved.ConfigDigest || observed.SessionID != binding.SessionID || observed.SkillSnapshotDigest != claim.SkillSnapshotDigest {
				return failNow("runtime_recovery_unsafe", true)
			}
			skillVersions = observed.SkillVersions
		}
		client := func() *Client { c, _ := NewClient(cfg.RuntimeURL, cfg.RuntimeToken, cfg.HTTPTransport); return c }()
		var answer *agent.AssistantResult
		polls := 0
		lastProgress := ""
		lastProgressAt := time.Time{}
		for {
			rawBytes, _, e := client.Forward(producerCtx, binding, "GET", "/session/"+binding.SessionID+"/message", nil)
			if e != nil {
				return failNow("runtime_read_unknown", true)
			}
			parsed, ready, e := AssistantTerminalResult(rawBytes, binding.SessionID, claim.ModelProfile.Model)
			if e != nil {
				return failNow("invalid_assistant_result", true)
			}
			if ready {
				answer = parsed
				break
			}
			// Live progress for the panel: tool stages + reasoning tail, only
			// when the digest changed and at most every 1.5s (rate limit —
			// the host appends each post as a conversation event). Best
			// effort: a failed post never fails the turn.
			if progress := AssistantProgressOf(rawBytes, binding.SessionID); producerCtx.Err() == nil {
				digest, _ := json.Marshal(progress)
				if string(digest) != lastProgress && time.Since(lastProgressAt) >= 1500*time.Millisecond {
					lastProgress, lastProgressAt = string(digest), time.Now()
					if _, err := post("assistant_progress", map[string]any{"progress": progress}); err != nil {
						log.Printf("assistant progress post skipped: %v", err)
					}
				}
			}
			// Diagnostics: a wedge here (runtime not delivering the terminal
			// message) otherwise sits invisible until the deadline; log
			// progress sparsely.
			polls++
			if polls%20 == 0 {
				log.Printf("assistant poll #%d: terminal not ready yet", polls)
			}
			if claim.Phase == "reconcile" {
				return failNow("runtime_recovery_pending", true)
			}
			interval := cfg.PollInterval
			if interval <= 0 {
				interval = 500 * time.Millisecond
			}
			timer := time.NewTimer(interval)
			select {
			case <-producerCtx.Done():
				timer.Stop()
				return failNow("runtime_deadline_unknown", true)
			case <-timer.C:
			}
		}
		payload := map[string]any{
			"schema_version":  1,
			"conversation_id": strings.TrimPrefix(claim.ItemID, "assistant:"),
			"turn_id":         strings.TrimPrefix(claim.ItemID, "assistant:"),
			"result":          answer,
			"runtime":         map[string]any{"model": claim.ModelProfile.Model, "prompt_version": "opencode-assistant-v1", "skill_versions": skillVersions, "input_tokens": nil, "output_tokens": nil, "model_calls": 1, "tool_calls": 0, "events": []any{}},
		}
		if _, err := post("assistant_result", payload); err != nil {
			return failNow("assistant_result_denied", true)
		}
		// Capture the binding identity before cleanup clears it.
		stoppedEpoch, stoppedInstance := binding.Epoch, binding.InstanceID
		if err := cleanup(); err != nil {
			return err
		}
		// §4.4 stage 2: the runtime is confirmed stopped (cleanup verified
		// the process tree); post the stop receipt so the host finalizer can
		// settle the run, write the assistant message and release the turn.
		stopReceipt := map[string]any{"stage": "runtime_stopped", "epoch": stoppedEpoch, "instance": stoppedInstance, "ok": true}
		if _, err := post("assistant_result", stopReceipt); err != nil {
			return failNow("stop_receipt_denied", true)
		}
	}
	return nil
}

// runtimeRequest posts directly to the runtime control endpoints (abort/stop)
// through the shared transport helpers.
func runtimeRequest(ctx context.Context, cfg WorkerConfig, method, path string, body any) ([]byte, int, error) {
	raw, _ := json.Marshal(body)
	return workerHTTP(ctx, cfg, method, cfg.RuntimeURL+path, cfg.RuntimeToken, raw, MaxRuntimeBytes)
}

func clientHealth(ctx context.Context, cfg WorkerConfig) error {
	client := func() *Client { c, _ := NewClient(cfg.RuntimeURL, cfg.RuntimeToken, cfg.HTTPTransport); return c }()
	return client.Health(ctx)
}
