package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/adk/middlewares/skill"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

func TestInvariantSkillResourceBudgetAndBoundary(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "demo", "references"), 0700)
	os.WriteFile(filepath.Join(root, "demo", "SKILL.md"), []byte("---\nname: demo\ndescription: demo\n---\nRead evidence."), 0600)
	os.WriteFile(filepath.Join(root, "demo", "references", "fact.md"), []byte("resource fact"), 0600)
	used := map[string]string{}
	resource := skillResourceTool(Config{SkillsDir: root}, used, nil).(tool.InvokableTool)
	b := &runBudget{toolLeft: 2}
	ctx := withBudget(context.Background(), b)
	if out, err := resource.InvokableRun(ctx, `{"skill":"demo","path":"references/fact.md"}`); err != nil || out != "resource fact" {
		t.Fatalf("legal resource %s %v", out, err)
	}
	if _, err := resource.InvokableRun(ctx, `{"skill":"demo","path":"../../outside"}`); err == nil {
		t.Fatal("path escape")
	}
	if _, err := resource.InvokableRun(ctx, `{"skill":"demo","path":"references/fact.md"}`); err == nil {
		t.Fatal("resource bypassed budget")
	}
	if used["demo"] == "" {
		t.Fatal("used resource version missing")
	}
}

func TestInvariantUnknownUsageIsNotPartialTotal(t *testing.T) {
	b := &runBudget{}
	b.addUsage(&schema.Message{ResponseMeta: &schema.ResponseMeta{Usage: &schema.TokenUsage{PromptTokens: 10, CompletionTokens: 2}}})
	b.addUsage(nil)
	i, o := b.usage()
	if i != nil || o != nil {
		t.Fatal("unknown call rendered as known aggregate")
	}
}

type countedSkills struct{ calls atomic.Int32 }

func (s *countedSkills) List(context.Context) ([]skill.FrontMatter, error) { return nil, nil }
func (s *countedSkills) Get(context.Context, string) (skill.Skill, error) {
	s.calls.Add(1)
	return skill.Skill{Content: "read-only evidence"}, nil
}

func TestInvariantSkillMixedParallelBudget(t *testing.T) {
	for _, limit := range []int{0, 1, 3, 9} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			backend := &countedSkills{}
			used := map[string]string{}
			wrapped := &budgetSkillBackend{Backend: backend, versions: map[string]string{"demo": "hash"}, used: used}
			budget := &runBudget{toolLeft: limit}
			ctx := withBudget(context.Background(), budget)
			var done sync.WaitGroup
			var internal atomic.Int32
			for i := 0; i < 40; i++ {
				done.Add(1)
				go func(i int) {
					defer done.Done()
					if i%2 == 0 {
						wrapped.Get(ctx, "demo")
					} else {
						guardedTool(ctx, nil, "internal", func() (string, error) { internal.Add(1); return "ok", nil })
					}
				}(i)
			}
			done.Wait()
			if total := backend.calls.Load() + internal.Load(); total != int32(limit) {
				t.Fatalf("actual calls %d budget %d", total, limit)
			}
			if _, err := wrapped.Get(ctx, "demo"); err == nil {
				t.Fatal("exhausted skill returned result")
			}
			if len(used) > 0 && backend.calls.Load() == 0 {
				t.Fatal("available recorded as used")
			}
		})
	}
}

func TestInvariantStreamCloseAndCancel(t *testing.T) {
	for _, cancelOnly := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelOnly), func(t *testing.T) {
			disconnected := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"id\":\"s\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"}}]}\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(disconnected)
			}))
			defer srv.Close()
			inner, _ := newChatModel(Config{ModelBaseURL: srv.URL + "/v1", ModelName: "fake", ModelAPIKey: "fake"}, time.Second, 12)
			b := &runBudget{modelLeft: 1}
			events := []RuntimeEvent{}
			m := budgetModel{inner: inner, budget: b, events: &events, name: "fake"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			reader, err := m.Stream(ctx, []*schema.Message{schema.UserMessage("hi")})
			if err != nil {
				t.Fatal(err)
			}
			if cancelOnly {
				cancel()
			} else {
				reader.Close()
			}
			select {
			case <-disconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("supplier stream leaked")
			}
			end := time.Now().Add(time.Second)
			for {
				b.mu.Lock()
				n := len(events)
				ok := n == 1 && !events[0].OK
				b.mu.Unlock()
				if ok {
					break
				}
				if time.Now().After(end) {
					t.Fatal("missing incomplete stream event")
				}
				time.Sleep(time.Millisecond)
			}
			if cancelOnly {
				reader.Close()
			}
		})
	}
}

func TestInvariantRepairIncludesActualOutputAndAggregatesFailedUsage(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		n := calls.Add(1)
		if n == 2 && (!strings.Contains(string(raw), "broken-marker") || !strings.Contains(string(raw), "summary") || !strings.Contains(string(raw), "evidence_id")) {
			t.Error("repair omitted original output/schema/evidence rules")
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": "broken-marker"}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 17, "completion_tokens": 5, "total_tokens": 22}})
	}))
	defer srv.Close()
	resp, err := Execute(context.Background(), Config{ModelBaseURL: srv.URL + "/v1", ModelName: "fake", ModelAPIKey: "fake"}, analyzeReq())
	if err != nil || resp.OK || resp.Runtime == nil || resp.Runtime.InputTokens == nil || *resp.Runtime.InputTokens != 34 || *resp.Runtime.OutputTokens != 10 || resp.Runtime.ModelCalls != 2 {
		t.Fatalf("lost failed repair facts: %+v %v", resp.Runtime, err)
	}
}
