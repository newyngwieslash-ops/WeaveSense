package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/schema"
)

type runBudget struct {
	mu           sync.Mutex
	modelLeft    int
	toolLeft     int
	inputTokens  int
	outputTokens int
	knownUsage   int
	usageCalls   int
}

func (b *runBudget) addUsage(msg *schema.Message) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.usageCalls++
	if msg == nil || msg.ResponseMeta == nil || msg.ResponseMeta.Usage == nil {
		return
	}
	u := msg.ResponseMeta.Usage
	if u.PromptTokens == 0 && u.CompletionTokens == 0 {
		return
	}
	b.inputTokens += u.PromptTokens
	b.outputTokens += u.CompletionTokens
	b.knownUsage++
}

func (b *runBudget) usage() (*int, *int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.knownUsage == 0 || b.knownUsage != b.usageCalls {
		return nil, nil
	}
	i, o := b.inputTokens, b.outputTokens
	return &i, &o
}

func (b *runBudget) takeModel() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.modelLeft <= 0 {
		return false
	}
	b.modelLeft--
	return true
}

func (b *runBudget) takeTool() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.toolLeft <= 0 {
		return false
	}
	b.toolLeft--
	return true
}

type ctxKey int

const (
	ctxBudget ctxKey = iota
	ctxRunToken
	ctxEvidence
	ctxEvents
)

func withBudget(ctx context.Context, b *runBudget) context.Context {
	return context.WithValue(ctx, ctxBudget, b)
}

func budgetFrom(ctx context.Context) *runBudget {
	b, _ := ctx.Value(ctxBudget).(*runBudget)
	return b
}

func withRunToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, ctxRunToken, token)
}

func runTokenFrom(ctx context.Context) string {
	s, _ := ctx.Value(ctxRunToken).(string)
	return s
}

type evidenceBag struct {
	mu    sync.Mutex
	items []Evidence
}

func (e *evidenceBag) add(ev Evidence) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.items = append(e.items, ev)
}

func (e *evidenceBag) all() []Evidence {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Evidence, len(e.items))
	copy(out, e.items)
	return out
}

func internalTools(cfg Config, runID string, events *[]RuntimeEvent) []tool.BaseTool {
	search := toolutils.NewTool(&schema.ToolInfo{
		Name: "search_items", Desc: "Search corpus titles and bodies",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"query": {Type: schema.String, Desc: "keyword", Required: true},
			"limit": {Type: schema.Integer, Desc: "1-8"},
		}),
	}, func(ctx context.Context, in map[string]any) (string, error) {
		return guardedTool(ctx, events, "search_items", func() (string, error) {
			return callDataAPI(ctx, cfg, runID, "search_items", in)
		})
	})
	getItem := toolutils.NewTool(&schema.ToolInfo{
		Name: "get_item", Desc: "Read one item fragment",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"item_id": {Type: schema.String, Desc: "item id", Required: true},
			"start":   {Type: schema.Integer, Desc: "code point start"},
		}),
	}, func(ctx context.Context, in map[string]any) (string, error) {
		return guardedTool(ctx, events, "get_item", func() (string, error) {
			return callDataAPI(ctx, cfg, runID, "get_item", in)
		})
	})
	getAnalysis := toolutils.NewTool(&schema.ToolInfo{
		Name: "get_analysis", Desc: "Read latest analysis",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"item_id": {Type: schema.String, Desc: "item id", Required: true},
		}),
	}, func(ctx context.Context, in map[string]any) (string, error) {
		return guardedTool(ctx, events, "get_analysis", func() (string, error) {
			return callDataAPI(ctx, cfg, runID, "get_analysis", in)
		})
	})
	return []tool.BaseTool{search, getItem, getAnalysis}
}

func guardedTool(ctx context.Context, events *[]RuntimeEvent, name string, run func() (string, error)) (string, error) {
	b := budgetFrom(ctx)
	if b != nil && !b.takeTool() {
		return "", fmt.Errorf("budget_exceeded")
	}
	start := time.Now()
	out, err := run()
	if events != nil {
		lock := budgetFrom(ctx)
		if lock != nil {
			lock.mu.Lock()
		}
		*events = append(*events, RuntimeEvent{Type: "tool", Name: name, DurationMS: int(time.Since(start).Milliseconds()), OK: err == nil})
		if lock != nil {
			lock.mu.Unlock()
		}
	}
	return out, err
}

func callDataAPI(ctx context.Context, cfg Config, runID, action string, params map[string]any) (string, error) {
	if cfg.DataURL == "" || cfg.DataToken == "" {
		return "", fmt.Errorf("tool_unavailable")
	}
	body, _ := json.Marshal(map[string]any{"run_id": runID, "action": action, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.DataURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.DataToken)
	if token := runTokenFrom(ctx); token != "" {
		req.Header.Set("X-Agent-Run-Token", token)
	}
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("tool_unavailable")
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("tool_denied")
	}
	if bag, _ := ctx.Value(ctxEvidence).(*evidenceBag); bag != nil && action == "get_item" {
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) == nil {
			if id, _ := parsed["evidence_id"].(string); id != "" {
				text, _ := parsed["text"].(string)
				itemID, _ := parsed["item_id"].(string)
				var ptr *string
				if itemID != "" {
					ptr = &itemID
				}
				bag.add(Evidence{EvidenceID: id, ItemID: ptr, Text: text, Origin: OriginInternal})
			}
		}
	}
	return string(raw), nil
}
