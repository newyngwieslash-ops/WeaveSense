package agent

import (
	"context"
	"crypto/rand"
	"fmt"
	"github.com/cloudwego/eino/schema"
)

type executionReceipt struct {
	cfg Config
	req ExecuteRequest
}
type executionKey struct{}

func receiptID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func beforeModelCall(ctx context.Context) (string, error) {
	e, ok := ctx.Value(executionKey{}).(executionReceipt)
	if !ok || e.cfg.DataURL == "" || e.req.DataAccessToken == "" {
		return "", nil
	}
	id := receiptID()
	_, err := callDataAPI(withRunToken(ctx, e.req.DataAccessToken), e.cfg, e.req.RunID, "model_call", map[string]any{
		"call_id": id, "phase": "started", "model": e.cfg.ModelName, "policy_version": e.req.Policy.Version,
	})
	return id, err
}

func afterModelCall(ctx context.Context, id string, msg *schema.Message, callErr error) error {
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
	_, err := callDataAPI(withRunToken(ctx, e.req.DataAccessToken), e.cfg, e.req.RunID, "model_call", map[string]any{
		"call_id": id, "phase": phase, "model": e.cfg.ModelName, "policy_version": e.req.Policy.Version, "input_tokens": input, "output_tokens": output,
	})
	return err
}
