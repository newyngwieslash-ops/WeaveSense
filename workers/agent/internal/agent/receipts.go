package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"

	"github.com/cloudwego/eino/schema"
)

type executionReceipt struct {
	cfg Config
	req ExecuteRequest
}
type executionKey struct{}
type governedExecutionKey struct{}

// The worker sets this only after receiving a governed claim from the host.
func withGovernedExecution(ctx context.Context, deadline time.Time) (context.Context, context.CancelFunc) {
	return context.WithDeadline(context.WithValue(ctx, governedExecutionKey{}, true), deadline)
}

func isGovernedExecution(ctx context.Context) bool {
	governed, _ := ctx.Value(governedExecutionKey{}).(bool)
	return governed
}

type modelAdmissionError struct{ unknown bool }

func (e *modelAdmissionError) Error() string {
	if e.unknown {
		return "model_outcome_unknown"
	}
	return "model_admission_unavailable"
}

func modelMessagesDigest(ctx context.Context, messages []*schema.Message) (string, error) {
	if !isGovernedExecution(ctx) {
		return "", nil
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return "", &modelAdmissionError{}
	}
	digest, err := reviewJSONDigest(raw)
	if err != nil {
		return "", &modelAdmissionError{}
	}
	return digest, nil
}

func admissionDisposition(raw string, expected string) error {
	var ack struct {
		OK          bool   `json:"ok"`
		Disposition string `json:"disposition"`
	}
	if json.Unmarshal([]byte(raw), &ack) != nil || !ack.OK || ack.Disposition != expected {
		return &modelAdmissionError{unknown: true}
	}
	return nil
}

func receiptID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func beforeModelCall(ctx context.Context, digests ...string) (string, error) {
	e, ok := ctx.Value(executionKey{}).(executionReceipt)
	governed := isGovernedExecution(ctx)
	if governed && (!ok || e.cfg.DataURL == "" || e.cfg.DataToken == "" || e.req.DataAccessToken == "" || len(digests) != 1 || !reviewDigestRE.MatchString(digests[0])) {
		return "", &modelAdmissionError{}
	}
	if !ok || e.cfg.DataURL == "" || e.req.DataAccessToken == "" {
		return "", nil
	}
	id := receiptID()
	params := map[string]any{
		"call_id": id, "phase": "started", "model": e.cfg.ModelName, "policy_version": e.req.Policy.Version,
	}
	if governed {
		params["request_digest"] = digests[0]
	}
	raw, err := callDataAPI(withRunToken(ctx, e.req.DataAccessToken), e.cfg, e.req.RunID, "model_call", params)
	if governed {
		if err != nil {
			return id, &modelAdmissionError{unknown: true}
		}
		err = admissionDisposition(raw, "send_once")
	}
	return id, err
}

func afterModelCall(ctx context.Context, id string, msg *schema.Message, callErr error, digests ...string) error {
	if id == "" {
		return nil
	}
	e := ctx.Value(executionKey{}).(executionReceipt)
	phase := "completed"
	if callErr != nil {
		phase = "unknown"
	}
	var input, output *int
	if msg != nil && msg.ResponseMeta != nil && msg.ResponseMeta.Usage != nil {
		u := msg.ResponseMeta.Usage
		if u.PromptTokens != 0 || u.CompletionTokens != 0 {
			input = &u.PromptTokens
			output = &u.CompletionTokens
		}
	}
	params := map[string]any{
		"call_id": id, "phase": phase, "model": e.cfg.ModelName, "policy_version": e.req.Policy.Version, "input_tokens": input, "output_tokens": output,
	}
	governed := isGovernedExecution(ctx)
	if governed {
		if len(digests) != 1 || !reviewDigestRE.MatchString(digests[0]) {
			return &modelAdmissionError{unknown: true}
		}
		params["request_digest"] = digests[0]
	}
	raw, err := callDataAPI(withRunToken(ctx, e.req.DataAccessToken), e.cfg, e.req.RunID, "model_call", params)
	if governed {
		if err != nil || callErr != nil {
			return &modelAdmissionError{unknown: true}
		}
		return admissionDisposition(raw, phase)
	}
	return err
}
