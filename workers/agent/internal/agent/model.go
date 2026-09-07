package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/schema"
)

type countedModel struct {
	inner     *openai.ChatModel
	remaining *int
	events    *[]RuntimeEvent
}

func newChatModel(cfg Config, timeout time.Duration) (*openai.ChatModel, error) {
	return openai.NewChatModel(context.Background(), &openai.ChatModelConfig{
		APIKey:     cfg.ModelAPIKey,
		Model:      cfg.ModelName,
		BaseURL:    cfg.ModelBaseURL,
		HTTPClient: &http.Client{Timeout: timeout},
	})
}

func remainingDeadline(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 30 * time.Second
	}
	left := time.Until(deadline)
	if left > 30*time.Second {
		return 30 * time.Second
	}
	if left < 0 {
		return 0
	}
	return left
}

func classifyModelError(err error) (code string, retryable, unknown bool) {
	if err == nil {
		return "", false, false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "model_timeout", false, true
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "401") || strings.Contains(msg, "403") || strings.Contains(msg, "400") {
		return "model_rejected", false, false
	}
	if strings.Contains(msg, "429") {
		return "model_rejected", true, false
	}
	return "agent_unavailable", true, false
}

func generateOnce(ctx context.Context, cfg Config, remaining *int, events *[]RuntimeEvent, messages []*schema.Message) (*schema.Message, error) {
	if remaining == nil || *remaining <= 0 {
		return nil, fmt.Errorf("budget_exceeded")
	}
	*remaining--
	timeout := remainingDeadline(ctx)
	if timeout <= 0 {
		return nil, context.DeadlineExceeded
	}
	cm, err := newChatModel(cfg, timeout)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	msg, err := cm.Generate(ctx, messages)
	ok := err == nil
	*events = append(*events, RuntimeEvent{
		Type: "model", Name: cfg.ModelName, DurationMS: int(time.Since(start).Milliseconds()), OK: ok,
	})
	return msg, err
}
