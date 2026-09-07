package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const runtimeVersion = "eino-v0.9.19"

type jobClaim struct {
	JobID      string `json:"job_id"`
	RunID      string `json:"run_id"`
	ClaimToken string `json:"claim_token"`
	Mode       Mode   `json:"mode"`
	Question   string `json:"question"`
}

type httpStore struct {
	cfg        Config
	runID      string
	claimToken string
	seq        int
}

func (s *httpStore) Get(ctx context.Context, checkPointID string) ([]byte, bool, error) {
	body, _ := json.Marshal(map[string]any{
		"action": "get_checkpoint", "run_id": s.runID, "check_point_id": checkPointID,
		"runtime_version": runtimeVersion,
	})
	raw, status, err := postJobs(ctx, s.cfg, body)
	if err != nil || status >= 400 {
		return nil, false, err
	}
	var parsed struct {
		Found   bool   `json:"found"`
		Payload []byte `json:"payload"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false, err
	}
	return parsed.Payload, parsed.Found, nil
}

func (s *httpStore) Set(ctx context.Context, checkPointID string, checkPoint []byte) error {
	s.seq++
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
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 300*1024))
	return raw, res.StatusCode, nil
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
		_ = RunWorkerOnce(ctx, cfg, execute)
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
	}
	resp, err := execute(ctx, req)
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
	_, _, _ = postJobs(ctx, cfg, body)
	return err
}
