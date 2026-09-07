package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/cloudwego/eino-ext/components/model/openai"
	mcpp "github.com/cloudwego/eino-ext/components/tool/mcp"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/adk/middlewares/skill"
	"github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func fakeOpenAIServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" && r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestModelRoundTrip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var gotModel string
	srv := fakeOpenAIServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotModel = body.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"chatcmpl-compat",
			"object":"chat.completion",
			"choices":[{"index":0,"message":{"role":"assistant","content":"{\"ok\":true}"},"finish_reason":"stop"}],
			"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}
		}`))
	})

	cm, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  "test-key",
		Model:   "compat-model",
		BaseURL: srv.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("NewChatModel: %v", err)
	}
	msg, err := cm.Generate(ctx, []*schema.Message{schema.UserMessage("ping")})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if gotModel != "compat-model" {
		t.Fatalf("model name = %q", gotModel)
	}
	if msg.Content != `{"ok":true}` {
		t.Fatalf("content = %q", msg.Content)
	}
	if msg.ResponseMeta == nil || msg.ResponseMeta.Usage == nil || msg.ResponseMeta.Usage.PromptTokens != 11 {
		t.Fatalf("usage not captured: %+v", msg.ResponseMeta)
	}
}

func TestToolCallRoundTrip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	calls := 0
	srv := fakeOpenAIServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Messages []struct {
				Role       string `json:"role"`
				Content    any    `json:"content"`
				ToolCallID string `json:"tool_call_id"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{
				"id":"chatcmpl-tool-1",
				"object":"chat.completion",
				"choices":[{
					"index":0,
					"message":{
						"role":"assistant",
						"content":"",
						"tool_calls":[{
							"id":"call_search",
							"type":"function",
							"function":{"name":"echo_item","arguments":"{\"q\":\"battery\"}"}
						}]
					},
					"finish_reason":"tool_calls"
				}]
			}`))
			return
		}
		foundTool := false
		for _, m := range body.Messages {
			content, _ := json.Marshal(m.Content)
			if m.Role == "tool" && m.ToolCallID == "call_search" && strings.Contains(string(content), "battery") {
				foundTool = true
			}
		}
		if !foundTool {
			http.Error(w, "tool result not fed back", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{
			"id":"chatcmpl-tool-2",
			"object":"chat.completion",
			"choices":[{"index":0,"message":{"role":"assistant","content":"cited battery"},"finish_reason":"stop"}]
		}`))
	})

	cm, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  "test-key",
		Model:   "compat-model",
		BaseURL: srv.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("NewChatModel: %v", err)
	}
	echo := toolutils.NewTool(&schema.ToolInfo{
		Name: "echo_item",
		Desc: "echo a query",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"q": {Type: schema.String, Desc: "query", Required: true},
		}),
	}, func(_ context.Context, in map[string]string) (string, error) {
		return "hit:" + in["q"], nil
	})
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:          "compat",
		Description:   "protocol probe",
		Instruction:   "Call echo_item then answer.",
		Model:         cm,
		MaxIterations: 4,
		ToolsConfig: adk.ToolsConfig{
			ToolsNodeConfig: compose.ToolsNodeConfig{Tools: []tool.BaseTool{echo}},
		},
	})
	if err != nil {
		t.Fatalf("NewChatModelAgent: %v", err)
	}
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent})
	iter := runner.Query(ctx, "find battery")
	var last string
	for {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			t.Fatalf("agent event: %v", event.Err)
		}
		if event.Output != nil && event.Output.MessageOutput != nil {
			msg, err := event.Output.MessageOutput.GetMessage()
			if err != nil {
				t.Fatalf("GetMessage: %v", err)
			}
			if msg != nil && msg.Role == schema.Assistant && msg.Content != "" {
				last = msg.Content
			}
		}
	}
	if calls != 2 {
		t.Fatalf("model HTTP calls = %d, want 2", calls)
	}
	if last != "cited battery" {
		t.Fatalf("final content = %q", last)
	}
}

type posixMemFS struct {
	files map[string]string
}

func (p *posixMemFS) LsInfo(context.Context, *filesystem.LsInfoRequest) ([]filesystem.FileInfo, error) {
	return nil, nil
}
func (p *posixMemFS) Read(_ context.Context, req *filesystem.ReadRequest) (*filesystem.FileContent, error) {
	content, ok := p.files[strings.ReplaceAll(req.FilePath, "\\", "/")]
	if !ok {
		return nil, os.ErrNotExist
	}
	return &filesystem.FileContent{Content: content}, nil
}
func (p *posixMemFS) GrepRaw(context.Context, *filesystem.GrepRequest) ([]filesystem.GrepMatch, error) {
	return nil, nil
}
func (p *posixMemFS) GlobInfo(_ context.Context, req *filesystem.GlobInfoRequest) ([]filesystem.FileInfo, error) {
	base := strings.TrimSuffix(strings.ReplaceAll(req.Path, "\\", "/"), "/")
	var out []filesystem.FileInfo
	for path := range p.files {
		rel := strings.TrimPrefix(path, base+"/")
		if req.Pattern == "*/SKILL.md" && strings.Count(rel, "/") == 1 && strings.HasSuffix(rel, "/SKILL.md") {
			out = append(out, filesystem.FileInfo{Path: rel})
		}
	}
	return out, nil
}
func (p *posixMemFS) Write(_ context.Context, req *filesystem.WriteRequest) error {
	if p.files == nil {
		p.files = map[string]string{}
	}
	p.files[strings.ReplaceAll(req.FilePath, "\\", "/")] = req.Content
	return nil
}
func (p *posixMemFS) Edit(context.Context, *filesystem.EditRequest) error { return nil }

func TestSkillLoad(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	body := "---\nname: cross-source-check\ndescription: compare sources\n---\n\nUse search_items then cite evidence_id.\n"
	mem := &posixMemFS{}
	if err := mem.Write(ctx, &filesystem.WriteRequest{
		FilePath: "/skills/cross-source-check/SKILL.md",
		Content:  body,
	}); err != nil {
		t.Fatalf("posix write: %v", err)
	}

	skillBackend, err := skill.NewBackendFromFilesystem(ctx, &skill.BackendFromFilesystemConfig{
		Backend: mem,
		BaseDir: "/skills",
	})
	if err != nil {
		t.Fatalf("NewBackendFromFilesystem: %v", err)
	}
	listed, err := skillBackend.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "cross-source-check" {
		t.Fatalf("listed = %+v", listed)
	}
	loaded, err := skillBackend.Get(ctx, "cross-source-check")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !strings.Contains(loaded.Content, "search_items") {
		t.Fatalf("content = %q", loaded.Content)
	}
	handler, err := skill.NewMiddleware(ctx, &skill.Config{Backend: skillBackend})
	if err != nil {
		t.Fatalf("NewMiddleware: %v", err)
	}
	idle := fakeOpenAIServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
	})
	cm, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  "test-key",
		Model:   "compat-model",
		BaseURL: idle.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("NewChatModel: %v", err)
	}
	agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:        "skill-probe",
		Description: "loads skills",
		Model:       cm,
		Handlers:    []adk.ChatModelAgentMiddleware{handler},
	})
	if err != nil {
		t.Fatalf("NewChatModelAgent: %v", err)
	}
	if agent == nil {
		t.Fatal("agent is nil")
	}
}

func TestMCPTransport(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	mcpSrv := mcpserver.NewMCPServer("compat", "1.0.0")
	mcpSrv.AddTool(mcp.NewTool("search",
		mcp.WithDescription("search corpus"),
		mcp.WithString("q", mcp.Required(), mcp.Description("query")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		q, err := req.RequireString("q")
		if err != nil {
			return nil, err
		}
		return mcp.NewToolResultText("found:" + q), nil
	})
	httpSrv := mcpserver.NewTestStreamableHTTPServer(mcpSrv)
	t.Cleanup(httpSrv.Close)

	cli, err := mcpclient.NewStreamableHttpClient(httpSrv.URL + "/mcp")
	if err != nil {
		t.Fatalf("NewStreamableHttpClient: %v", err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	if err := cli.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	initReq := mcp.InitializeRequest{}
	initReq.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	initReq.Params.ClientInfo = mcp.Implementation{Name: "loom-compat", Version: "1"}
	if _, err := cli.Initialize(ctx, initReq); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	tools, err := mcpp.GetTools(ctx, &mcpp.Config{Cli: cli, ToolNameList: []string{"search"}})
	if err != nil {
		t.Fatalf("GetTools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools = %d", len(tools))
	}
	inv, ok := tools[0].(tool.InvokableTool)
	if !ok {
		t.Fatal("tool is not InvokableTool")
	}
	out, err := inv.InvokableRun(ctx, `{"q":"battery"}`)
	if err != nil {
		t.Fatalf("InvokableRun: %v", err)
	}
	if !strings.Contains(out, "found:battery") {
		t.Fatalf("result = %q", out)
	}
}
