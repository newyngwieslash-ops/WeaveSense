package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	mcpp "github.com/cloudwego/eino-ext/components/tool/mcp"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
	mcpclient "github.com/mark3labs/mcp-go/client"
	mcptransport "github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

type mcpFile struct {
	Servers []mcpServer `json:"servers"`
}

type mcpServer struct {
	ID           string   `json:"id"`
	Enabled      bool     `json:"enabled"`
	URL          string   `json:"url"`
	Transport    string   `json:"transport"`
	TokenEnv     string   `json:"token_env"`
	AllowedTools []string `json:"allowed_tools"`
	Required     bool     `json:"required"`
}

var mcpNameRE = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)

func loadMCPTools(ctx context.Context, cfg Config, events *[]RuntimeEvent, bag *evidenceBag) ([]tool.BaseTool, []string, error) {
	if cfg.MCPConfigPath == "" {
		return nil, nil, nil
	}
	raw, err := os.ReadFile(cfg.MCPConfigPath)
	if err != nil {
		return nil, nil, err
	}
	var file mcpFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, nil, err
	}
	var out []tool.BaseTool
	var warnings []string
	seen := map[string]struct{}{}
	for _, srv := range file.Servers {
		if !srv.Enabled {
			continue
		}
		if srv.Transport != "streamable_http" {
			if srv.Required {
				return nil, nil, fmt.Errorf("unsupported transport")
			}
			warnings = append(warnings, "mcp_transport_unsupported:"+srv.ID)
			continue
		}
		if len(srv.AllowedTools) == 0 {
			continue
		}
		var opts []mcptransport.StreamableHTTPCOption
		opts = append(opts, mcptransport.WithHTTPBasicClient(&http.Client{Transport: limitedMCPTransport{}, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}))
		if srv.TokenEnv != "" {
			token := strings.TrimSpace(os.Getenv(srv.TokenEnv))
			if token == "" && srv.Required {
				return nil, nil, fmt.Errorf("mcp_token_missing")
			}
			if token != "" {
				opts = append(opts, mcptransport.WithHTTPHeaders(map[string]string{"Authorization": "Bearer " + token}))
			}
		}
		cli, err := mcpclient.NewStreamableHttpClient(srv.URL, opts...)
		if err != nil {
			if srv.Required {
				return nil, nil, err
			}
			warnings = append(warnings, "mcp_unavailable:"+srv.ID)
			continue
		}
		context.AfterFunc(ctx, func() { _ = cli.Close() })
		if err := cli.Start(ctx); err != nil {
			if srv.Required {
				return nil, nil, err
			}
			warnings = append(warnings, "mcp_unavailable:"+srv.ID)
			continue
		}
		initReq := mcp.InitializeRequest{}
		initReq.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
		initReq.Params.ClientInfo = mcp.Implementation{Name: "loom-agent", Version: "1"}
		if _, err := cli.Initialize(ctx, initReq); err != nil {
			if srv.Required {
				return nil, nil, err
			}
			warnings = append(warnings, "mcp_unavailable:"+srv.ID)
			continue
		}
		tools, err := mcpp.GetTools(ctx, &mcpp.Config{Cli: cli, ToolNameList: srv.AllowedTools})
		if err != nil {
			if srv.Required {
				return nil, nil, err
			}
			warnings = append(warnings, "mcp_unavailable:"+srv.ID)
			continue
		}
		for _, t := range tools {
			info, _ := t.Info(ctx)
			name := "mcp_" + srv.ID + "_" + info.Name
			if !mcpNameRE.MatchString(name) {
				return nil, nil, fmt.Errorf("invalid mcp tool name")
			}
			if _, ok := seen[name]; ok {
				return nil, nil, fmt.Errorf("mcp name conflict")
			}
			seen[name] = struct{}{}
			out = append(out, wrapMCPTool(t, name, events, bag))
		}
	}
	return out, warnings, nil
}

type limitedMCPTransport struct{}

func (limitedMCPTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := http.DefaultTransport.RoundTrip(req)
	if err == nil {
		res.Body = &limitedMCPBody{ReadCloser: res.Body, left: 64 * 1024}
	}
	return res, err
}

type limitedMCPBody struct {
	io.ReadCloser
	left int
}

func (b *limitedMCPBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		return 0, fmt.Errorf("mcp_response_too_large")
	}
	if len(p) > b.left {
		p = p[:b.left]
	}
	n, err := b.ReadCloser.Read(p)
	b.left -= n
	return n, err
}

type renamedTool struct {
	inner tool.InvokableTool
	name  string
}

func (r renamedTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	info, err := r.inner.Info(ctx)
	if err != nil {
		return nil, err
	}
	copied := *info
	copied.Name = r.name
	return &copied, nil
}

func (r renamedTool) InvokableRun(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
	b := budgetFrom(ctx)
	if b != nil && !b.takeTool() {
		return "", fmt.Errorf("budget_exceeded")
	}
	e, ok := ctx.Value(executionKey{}).(executionReceipt)
	if !ok || e.req.DataAccessToken == "" {
		return "", fmt.Errorf("receipt_unavailable")
	}
	callID := receiptID()
	if _, err := callDataAPI(ctx, e.cfg, e.req.RunID, "mcp_start", map[string]any{"call_id": callID, "result_index": 0, "tool": r.name, "title": r.name, "url": "", "text": "started"}); err != nil {
		return "", err
	}
	out, err := r.inner.InvokableRun(ctx, arguments, opts...)
	if err != nil {
		return "", err
	}
	var blocks struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if json.Unmarshal([]byte(out), &blocks) == nil && blocks.Content != nil {
		if len(blocks.Content) > 32 || blocks.IsError {
			return "", fmt.Errorf("mcp_invalid_result")
		}
		parts := []string{}
		for _, block := range blocks.Content {
			if block.Type == "text" {
				parts = append(parts, block.Text)
			}
		}
		out = strings.Join(parts, "\n")
		if strings.TrimSpace(out) == "" {
			return "", fmt.Errorf("mcp_no_text_evidence")
		}
	}
	runes := []rune(out)
	if len(runes) > 4000 {
		out = string(runes[:4000])
	}
	receipt, err := callDataAPI(ctx, e.cfg, e.req.RunID, "mcp_receipt", map[string]any{
		"call_id": callID, "result_index": 0, "tool": r.name, "title": r.name, "url": "", "text": out,
	})
	if err != nil {
		return "", err
	}
	var saved struct {
		EvidenceID string `json:"evidence_id"`
	}
	if json.Unmarshal([]byte(receipt), &saved) != nil || saved.EvidenceID == "" {
		return "", fmt.Errorf("invalid_receipt")
	}
	id := saved.EvidenceID
	if bag, _ := ctx.Value(ctxEvidence).(*evidenceBag); bag != nil {
		bag.add(Evidence{EvidenceID: id, Text: out, Origin: OriginMCP, Title: r.name})
	}
	encoded, _ := json.Marshal(map[string]string{"evidence_id": id, "text": out})
	return string(encoded), nil
}

func wrapMCPTool(t tool.BaseTool, name string, events *[]RuntimeEvent, bag *evidenceBag) tool.BaseTool {
	inv, ok := t.(tool.InvokableTool)
	if !ok {
		return t
	}
	_ = events
	_ = bag
	return renamedTool{inner: inv, name: name}
}
