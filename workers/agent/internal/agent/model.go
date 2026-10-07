package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

type countedModel struct {
	inner     *openai.ChatModel
	remaining *int
	events    *[]RuntimeEvent
}

const modelWireByteCap = 128000

type modelTransport struct{}

func (modelTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(req.Body, modelWireByteCap+1))
		req.Body.Close()
		if err != nil || len(raw) > modelWireByteCap {
			return nil, fmt.Errorf("input_budget_exceeded")
		}
		req.Body = io.NopCloser(bytes.NewReader(raw))
	}
	return http.DefaultTransport.RoundTrip(req)
}

func newChatModel(cfg Config, timeout time.Duration, maxOut int) (*openai.ChatModel, error) {
	out := maxOut
	return openai.NewChatModel(context.Background(), &openai.ChatModelConfig{
		APIKey:     cfg.ModelAPIKey,
		Model:      cfg.ModelName,
		BaseURL:    cfg.ModelBaseURL,
		MaxTokens:  &out,
		HTTPClient: &http.Client{Timeout: timeout, Transport: modelTransport{}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	})
}

type budgetModel struct {
	inner      *openai.ChatModel
	budget     *runBudget
	events     *[]RuntimeEvent
	name       string
	checkpoint bool
}

func (m *budgetModel) Generate(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	if m.checkpoint {
		if interrupted, hasState, state := compose.GetInterruptState[string](ctx); interrupted && hasState {
			var msg schema.Message
			if err := json.Unmarshal([]byte(state), &msg); err != nil {
				return nil, err
			}
			return &msg, nil
		}
	}
	if m.budget != nil && !m.budget.takeModel() {
		return nil, fmt.Errorf("budget_exceeded")
	}
	start := time.Now()
	digest, receiptErr := modelMessagesDigest(ctx, input)
	if receiptErr != nil {
		return nil, receiptErr
	}
	callID, receiptErr := beforeModelCall(ctx, digest)
	if receiptErr != nil {
		return nil, receiptErr
	}
	msg, err := m.inner.Generate(ctx, input, opts...)
	if receiptErr = afterModelCall(ctx, callID, msg, err, digest); receiptErr != nil {
		err = receiptErr
	}
	m.budget.addUsage(msg)
	if m.events != nil {
		m.budget.mu.Lock()
		*m.events = append(*m.events, RuntimeEvent{Type: "model", Name: m.name, DurationMS: int(time.Since(start).Milliseconds()), OK: err == nil})
		m.budget.mu.Unlock()
	}
	if err == nil && m.checkpoint {
		raw, marshalErr := json.Marshal(msg)
		if marshalErr != nil {
			return nil, marshalErr
		}
		return nil, compose.StatefulInterrupt(ctx, "model_result_saved", string(raw))
	}
	return msg, err
}

func (m *budgetModel) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	ctx, cancel := context.WithCancel(ctx)
	if m.budget != nil && !m.budget.takeModel() {
		cancel()
		return nil, fmt.Errorf("budget_exceeded")
	}
	start := time.Now()
	digest, receiptErr := modelMessagesDigest(ctx, input)
	if receiptErr != nil {
		cancel()
		return nil, receiptErr
	}
	callID, receiptErr := beforeModelCall(ctx, digest)
	if receiptErr != nil {
		cancel()
		return nil, receiptErr
	}
	stream, err := m.inner.Stream(ctx, input, opts...)
	var once sync.Once
	var last *schema.Message
	var finishErr error
	finish := func(ok bool) error {
		once.Do(func() {
			var callErr error
			if !ok {
				callErr = fmt.Errorf("stream_incomplete")
			}
			if finishErr = afterModelCall(ctx, callID, last, callErr, digest); finishErr != nil {
				ok = false
			}
			m.budget.addUsage(last)
			if m.events != nil {
				m.budget.mu.Lock()
				defer m.budget.mu.Unlock()
				*m.events = append(*m.events, RuntimeEvent{Type: "model", Name: m.name, DurationMS: int(time.Since(start).Milliseconds()), OK: ok})
			}
		})
		return finishErr
	}
	if err != nil {
		if receiptErr := finish(false); receiptErr != nil {
			err = receiptErr
		}
		cancel()
		return nil, err
	}
	reader, writer := schema.Pipe[*schema.Message](0)
	reader.SetAutomaticClose()
	stopCancel := context.AfterFunc(ctx, reader.Close)
	type chunk struct {
		msg *schema.Message
		err error
	}
	chunks := make(chan chunk, 1)
	go func() {
		defer stream.Close()
		for {
			msg, err := stream.Recv()
			select {
			case chunks <- chunk{msg, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer writer.Close()
		defer stopCancel()
		defer cancel()
		defer finish(false)
		// Eino's concrete reader exposes no Close hook. A filtered heartbeat detects a closed consumer even while the supplier is idle.
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if writer.Send(nil, nil) {
					return
				}
			case c := <-chunks:
				if c.msg != nil && c.msg.ResponseMeta != nil && c.msg.ResponseMeta.Usage != nil {
					last = c.msg
				}
				if c.err != nil {
					if receiptErr := finish(c.err == io.EOF && ctx.Err() == nil); receiptErr != nil {
						writer.Send(nil, receiptErr)
					} else if c.err != io.EOF {
						writer.Send(nil, c.err)
					}
					return
				}
				if writer.Send(c.msg, nil) {
					return
				}
			}
		}
	}()
	return schema.StreamReaderWithConvert(reader, func(msg *schema.Message) (*schema.Message, error) {
		if msg == nil {
			return nil, schema.ErrNoValue
		}
		return msg, nil
	}), nil
}

func (m *budgetModel) BindTools(tools []*schema.ToolInfo) error {
	return m.inner.BindTools(tools)
}

func remainingDeadline(ctx context.Context) time.Duration {
	return remainingModelDeadline(ctx, Config{})
}

func remainingModelDeadline(ctx context.Context, cfg Config) time.Duration {
	limit := cfg.ModelTimeout
	if limit <= 0 {
		limit = 30 * time.Second
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return limit
	}
	left := time.Until(deadline)
	if left > limit {
		return limit
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
	var admissionErr *modelAdmissionError
	if errors.As(err, &admissionErr) {
		return admissionErr.Error(), false, admissionErr.unknown
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

func generateOnce(ctx context.Context, cfg Config, remaining *int, maxOut int, events *[]RuntimeEvent, messages []*schema.Message) (*schema.Message, error) {
	if remaining == nil || *remaining <= 0 {
		return nil, fmt.Errorf("budget_exceeded")
	}
	*remaining--
	timeout := remainingModelDeadline(ctx, cfg)
	if timeout <= 0 {
		return nil, context.DeadlineExceeded
	}
	if maxOut <= 0 {
		return nil, fmt.Errorf("invalid_output_limit")
	}
	cm, err := newChatModel(cfg, timeout, maxOut)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	digest, receiptErr := modelMessagesDigest(ctx, messages)
	if receiptErr != nil {
		return nil, receiptErr
	}
	callID, receiptErr := beforeModelCall(ctx, digest)
	if receiptErr != nil {
		return nil, receiptErr
	}
	msg, err := cm.Generate(ctx, messages)
	if receiptErr = afterModelCall(ctx, callID, msg, err, digest); receiptErr != nil {
		err = receiptErr
	}
	if b := budgetFrom(ctx); b != nil {
		b.addUsage(msg)
	}
	ok := err == nil
	*events = append(*events, RuntimeEvent{
		Type: "model", Name: cfg.ModelName, DurationMS: int(time.Since(start).Milliseconds()), OK: ok,
	})
	return msg, err
}
