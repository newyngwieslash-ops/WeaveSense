package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync/atomic"
	"time"
)

const runtimeVersion = "eino-v0.9.19"

type jobClaim struct {
	JobID               string       `json:"job_id"`
	RunID               string       `json:"run_id"`
	ClaimToken          string       `json:"claim_token"`
	DataAccessToken     string       `json:"data_access_token"`
	Mode                Mode         `json:"mode"`
	Question            string       `json:"question"`
	Input               ExecuteInput `json:"input"`
	Policy              Policy       `json:"policy"`
	Resume              bool         `json:"resume"`
	Sequence            int          `json:"sequence"`
	Governed            bool         `json:"governed"`
	ProducerDeadlineAt  string       `json:"producer_deadline_at"`
	SkillSnapshotDigest string       `json:"skill_snapshot_digest"`
	ProducerModelCalls  int          `json:"producer_model_calls"`
	Phase               string       `json:"phase"`
}

type workerContextKey struct{}

type httpStore struct {
	cfg        Config
	runID      string
	claimToken string
	seq        int
	budget     *runBudget
	request    *ExecuteRequest
	events     *[]RuntimeEvent
	bag        *evidenceBag
	skills     map[string]string
}

type checkpointEnvelope struct {
	Schema       int               `json:"schema"`
	Runtime      string            `json:"runtime"`
	Model        string            `json:"model"`
	Policy       Policy            `json:"policy"`
	ModelLeft    int               `json:"model_left"`
	ToolLeft     int               `json:"tool_left"`
	InputTokens  int               `json:"input_tokens"`
	OutputTokens int               `json:"output_tokens"`
	KnownUsage   int               `json:"known_usage"`
	UsageCalls   int               `json:"usage_calls"`
	Events       []RuntimeEvent    `json:"events"`
	Evidence     []Evidence        `json:"evidence"`
	Skills       map[string]string `json:"skills"`
	State        []byte            `json:"state"`
}

func (s *httpStore) Get(ctx context.Context, checkPointID string) ([]byte, bool, error) {
	body, _ := json.Marshal(map[string]any{
		"action": "get_checkpoint", "run_id": s.runID, "check_point_id": checkPointID,
		"claim_token":     s.claimToken,
		"runtime_version": runtimeVersion,
	})
	raw, status, err := postJobs(ctx, s.cfg, body)
	if err != nil {
		return nil, false, err
	}
	if status >= 400 {
		return nil, false, fmt.Errorf("checkpoint_get_denied: %d", status)
	}
	var parsed struct {
		Found   bool   `json:"found"`
		Payload []byte `json:"payload"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false, err
	}
	if parsed.Found && s.budget != nil {
		var env checkpointEnvelope
		if json.Unmarshal(parsed.Payload, &env) != nil || env.Schema != 1 || env.Runtime != runtimeVersion || env.Model != s.cfg.ModelName || env.Policy != s.request.Policy {
			return nil, false, fmt.Errorf("checkpoint_version_mismatch")
		}
		if len(env.Skills) > 0 {
			versions, err := skillVersionsFor(ctx, s.cfg)
			if err != nil {
				return nil, false, err
			}
			for name, version := range env.Skills {
				if versions[name] != version {
					return nil, false, fmt.Errorf("checkpoint_skill_mismatch")
				}
			}
		}
		b := s.budget
		b.mu.Lock()
		b.modelLeft = env.ModelLeft
		b.toolLeft = env.ToolLeft
		b.inputTokens = env.InputTokens
		b.outputTokens = env.OutputTokens
		b.knownUsage = env.KnownUsage
		b.usageCalls = env.UsageCalls
		b.mu.Unlock()
		*s.events = env.Events
		s.bag.mu.Lock()
		s.bag.items = nil
		s.bag.mu.Unlock()
		for _, ev := range env.Evidence {
			s.bag.add(ev)
		}
		for name, version := range env.Skills {
			s.skills[name] = version
		}
		return env.State, true, nil
	}
	return parsed.Payload, parsed.Found, nil
}

func (s *httpStore) Set(ctx context.Context, checkPointID string, checkPoint []byte) error {
	s.seq++
	if s.budget != nil {
		b := s.budget
		b.mu.Lock()
		env := checkpointEnvelope{Schema: 1, Runtime: runtimeVersion, Model: s.cfg.ModelName, Policy: s.request.Policy,
			ModelLeft: b.modelLeft, ToolLeft: b.toolLeft, InputTokens: b.inputTokens, OutputTokens: b.outputTokens, KnownUsage: b.knownUsage, UsageCalls: b.usageCalls,
			Events: *s.events, Evidence: s.bag.all(), Skills: s.skills, State: checkPoint}
		b.mu.Unlock()
		var err error
		checkPoint, err = json.Marshal(env)
		if err != nil {
			return err
		}
	}
	body, _ := json.Marshal(map[string]any{
		"action": "save_checkpoint", "run_id": s.runID, "claim_token": s.claimToken,
		"check_point_id": checkPointID, "sequence": s.seq, "schema_version": "1",
		"runtime_version": runtimeVersion, "payload": checkPoint,
	})
	_, status, err := postJobs(ctx, s.cfg, body)
	if err != nil {
		return err
	}
	if status == 409 {
		return fmt.Errorf("stale_claim")
	}
	if status >= 400 {
		return fmt.Errorf("checkpoint_denied")
	}
	return nil
}

func postJobs(ctx context.Context, cfg Config, body []byte) ([]byte, int, error) {
	if cfg.DataURL == "" {
		return nil, 0, fmt.Errorf("jobs url missing")
	}
	url := cfg.DataURL
	if len(url) > 0 {
		url = trimSuffix(url, "/agent-data") + "/agent-jobs"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.DataToken)
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, MaxRequestBytes+1025))
	if len(raw) > MaxRequestBytes+1024 {
		return nil, res.StatusCode, fmt.Errorf("jobs_response_too_large")
	}
	return raw, res.StatusCode, readErr
}

func trimSuffix(s, suffix string) string {
	if len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix {
		return s[:len(s)-len(suffix)]
	}
	return s
}

func RunWorkerLoop(ctx context.Context, cfg Config, execute func(context.Context, ExecuteRequest) (ExecuteResponse, error)) {
	if cfg.DataURL == "" || cfg.DataToken == "" {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := RunWorkerOnce(ctx, cfg, execute); err != nil {
			log.Printf("agent worker: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func RunWorkerOnce(ctx context.Context, cfg Config, execute func(context.Context, ExecuteRequest) (ExecuteResponse, error)) error {
	raw, status, err := postJobs(ctx, cfg, []byte(`{"action":"claim"}`))
	if err != nil {
		return err
	}
	if status == 204 || status == 404 {
		return nil
	}
	if status >= 400 {
		return fmt.Errorf("claim_denied")
	}
	var claim jobClaim
	if err := json.Unmarshal(raw, &claim); err != nil {
		return err
	}
	req := ExecuteRequest{
		SchemaVersion: 1, RunID: claim.RunID, Mode: claim.Mode,
		Input: ExecuteInput{Question: claim.Question},
		Policy: Policy{Version: "loom-agent-v1", DeadlineAt: time.Now().Add(40 * time.Second).UTC().Format(time.RFC3339),
			MaxModelCalls: 6, MaxToolCalls: 4, MaxOutputTokensPerCall: 1800},
		DataAccessToken: claim.DataAccessToken,
	}
	if claim.Policy.Version != "" {
		req.Policy = claim.Policy
		req.Input = claim.Input
	}
	if claim.Governed {
		return runGovernedClaim(ctx, cfg, claim, req, execute)
	}
	execCtx, cancel := context.WithCancel(ctx)
	execCtx = context.WithValue(execCtx, workerContextKey{}, claim)
	renewDone := make(chan struct{})
	defer func() { cancel(); <-renewDone }()
	go func() {
		defer close(renewDone)
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-execCtx.Done():
				return
			case <-tick.C:
				body, _ := json.Marshal(map[string]any{"action": "renew", "job_id": claim.JobID, "run_id": claim.RunID, "claim_token": claim.ClaimToken})
				_, status, err := postJobs(execCtx, cfg, body)
				if err != nil || status >= 400 {
					cancel()
					return
				}
			}
		}
	}()
	resp, err := execute(execCtx, req)
	complete := map[string]any{
		"action": "complete", "job_id": claim.JobID, "run_id": claim.RunID,
		"claim_token": claim.ClaimToken,
	}
	if err != nil {
		complete["status"] = "outcome_unknown"
		complete["error_code"] = "outcome_unknown"
	} else if resp.OK {
		complete["status"] = "succeeded"
		complete["response"] = resp
	} else if resp.Error != nil && resp.Error.OutcomeUnknown {
		complete["status"] = "outcome_unknown"
		complete["error_code"] = resp.Error.Code
	} else {
		complete["status"] = "failed"
		if resp.Error != nil {
			complete["error_code"] = resp.Error.Code
		}
	}
	body, _ := json.Marshal(complete)
	if err == nil && !resp.OK {
		complete["response"] = resp
		body, _ = json.Marshal(complete)
	}
	// Retain the exact serialized result until ACK. Never invoke execute to retry persistence.
	for attempt := 0; ; attempt++ {
		_, completeStatus, completeErr := postJobs(execCtx, cfg, body)
		if completeErr == nil && completeStatus >= 200 && completeStatus < 300 {
			return nil
		}
		if completeErr == nil && completeStatus >= 400 && completeStatus < 500 && completeStatus != 429 {
			if completeStatus == 400 && complete["status"] == "succeeded" {
				// Invalid evidence/output is diagnostic failure, never a reason to run the model again.
				complete["status"] = "failed"
				complete["error_code"] = "invalid_output"
				delete(complete, "response")
				body, _ = json.Marshal(complete)
				continue
			}
			return fmt.Errorf("complete_denied: %d", completeStatus)
		}
		log.Printf("agent complete ACK pending (attempt %d, status %d)", attempt+1, completeStatus)
		timer := time.NewTimer(time.Duration(min(attempt+1, 8)) * 250 * time.Millisecond)
		select {
		case <-execCtx.Done():
			timer.Stop()
			return execCtx.Err()
		case <-timer.C:
		}
	}
}

// Persistence retries keep the original envelope; they never repeat model execution.
func postGovernedJobs(ctx context.Context, cfg Config, body []byte) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		raw, status, err := postJobs(ctx, cfg, body)
		if err == nil && status == http.StatusOK {
			var ack struct {
				OK bool `json:"ok"`
			}
			if json.Unmarshal(raw, &ack) == nil && ack.OK {
				return raw, nil
			}
		}
		if err == nil && status >= 400 && status < 500 && status != http.StatusTooManyRequests {
			return nil, fmt.Errorf("governed_job_denied: %d", status)
		}
		timer := time.NewTimer(time.Duration(min(attempt+1, 8)) * 250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func runGovernedClaim(parent context.Context, cfg Config, claim jobClaim, req ExecuteRequest, execute func(context.Context, ExecuteRequest) (ExecuteResponse, error)) error {
	deadline, err := time.Parse(time.RFC3339, claim.Policy.DeadlineAt)
	if err != nil || !deadline.After(time.Now()) {
		return fmt.Errorf("invalid_claim_deadline")
	}
	if claim.Phase != "producer" && claim.Phase != "review" && claim.Phase != "finalize" {
		return fmt.Errorf("invalid_claim_phase")
	}
	// Renewal keeps running during review and persistence. User cancellation stops
	// execution, while the still-leased run context can acknowledge its outcome.
	runCtx, stopRun := context.WithDeadline(parent, deadline)
	execCtx, stopExecution := context.WithCancel(runCtx)
	execCtx = context.WithValue(execCtx, workerContextKey{}, claim)
	var cancellation atomic.Bool
	renewDone := make(chan struct{})
	defer func() { stopExecution(); stopRun(); <-renewDone }()
	envelope := func(action string) map[string]any {
		return map[string]any{"action": action, "job_id": claim.JobID, "run_id": claim.RunID, "claim_token": claim.ClaimToken}
	}
	post := func(body map[string]any) ([]byte, error) {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		return postGovernedJobs(runCtx, cfg, raw)
	}
	go func() {
		defer close(renewDone)
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				body, _ := json.Marshal(envelope("renew"))
				raw, status, renewErr := postJobs(runCtx, cfg, body)
				var ack struct {
					OK              bool `json:"ok"`
					CancelRequested bool `json:"cancel_requested"`
				}
				if renewErr != nil || status != http.StatusOK || json.Unmarshal(raw, &ack) != nil || !ack.OK {
					stopRun()
					return
				}
				if ack.CancelRequested {
					cancellation.Store(true)
					stopExecution()
				}
			}
		}
	}()
	if claim.Phase == "producer" {
		producerDeadline, parseErr := time.Parse(time.RFC3339, claim.ProducerDeadlineAt)
		var response ExecuteResponse
		var executeErr error
		if parseErr != nil || !producerDeadline.After(time.Now()) || producerDeadline.After(deadline) || claim.ProducerModelCalls < 1 || claim.ProducerModelCalls > req.Policy.MaxModelCalls {
			response = fail(claim.RunID, "invalid_producer_policy", false, false)
		} else {
			frozen, snapshotErr := withSkillSnapshot(execCtx, cfg)
			if snapshotErr != nil || !reviewDigestRE.MatchString(claim.SkillSnapshotDigest) || skillSnapshotDigest(frozen) != claim.SkillSnapshotDigest {
				response = fail(claim.RunID, "skill_snapshot_mismatch", false, false)
			} else {
				producerCtx, stopProducer := withGovernedExecution(frozen, producerDeadline)
				req.Policy.MaxModelCalls = claim.ProducerModelCalls
				response, executeErr = execute(producerCtx, req)
				stopProducer()
			}
		}
		if cancellation.Load() {
			response = fail(claim.RunID, "cancelled", false, true)
			executeErr = nil
		}
		if executeErr != nil || !response.OK {
			body := envelope("complete")
			body["status"] = "failed"
			if executeErr != nil {
				body["status"] = "outcome_unknown"
				body["error_code"] = "outcome_unknown"
			} else {
				body["response"] = response
				if response.Error != nil {
					body["error_code"] = response.Error.Code
					if response.Error.OutcomeUnknown {
						body["status"] = "outcome_unknown"
					}
				}
			}
			_, err = post(body)
			return err
		}
		body := envelope("candidate")
		body["response"] = response
		if _, err = post(body); err != nil {
			return err
		}
	}
	if claim.Phase != "finalize" {
		var result ReviewResponse
		if cancellation.Load() {
			result = ReviewResponse{Error: &ReviewError{Code: "cancelled", OutcomeUnknown: true}}
		} else {
			raw, startErr := post(envelope("review_start"))
			if startErr != nil {
				return startErr
			}
			var start struct {
				OK      bool            `json:"ok"`
				Skip    bool            `json:"skip"`
				Request json.RawMessage `json:"request"`
			}
			if json.Unmarshal(raw, &start) != nil {
				return fmt.Errorf("invalid_review_start")
			}
			if !start.Skip {
				reviewRequest, parseErr := ParseReviewRequest(start.Request)
				if parseErr != nil || reviewRequest.RunID != claim.RunID {
					result = ReviewResponse{Error: &ReviewError{Code: "invalid_review_request"}}
				} else {
					result, err = Review(execCtx, cfg, reviewRequest)
					if err != nil {
						result = ReviewResponse{Error: &ReviewError{Code: "review_outcome_unknown", OutcomeUnknown: true}}
					}
				}
			}
		}
		if cancellation.Load() {
			result = ReviewResponse{Error: &ReviewError{Code: "cancelled", OutcomeUnknown: true}}
		}
		if result.OK && result.Report != nil {
			body := envelope("review_result")
			body["report"] = result.Report
			if _, err = post(body); err != nil {
				return err
			}
		} else if result.Error != nil {
			body := envelope("review_error")
			body["error_code"] = result.Error.Code
			body["outcome_unknown"] = result.Error.OutcomeUnknown
			if _, err = post(body); err != nil {
				return err
			}
		}
	}
	_, err = post(envelope("finalize"))
	return err
}
