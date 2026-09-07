package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"

	mcpp "github.com/cloudwego/eino-ext/components/tool/mcp"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
	mcpclient "github.com/mark3labs/mcp-go/client"
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
		cli, err := mcpclient.NewStreamableHttpClient(srv.URL)
		if err != nil {
			if srv.Required {
				return nil, nil, err
			}
			warnings = append(warnings, "mcp_unavailable:"+srv.ID)
			continue
		}
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
	out, err := r.inner.InvokableRun(ctx, arguments, opts...)
	if err != nil {
		return "", err
	}
	runes := []rune(out)
	if len(runes) > 4000 {
		out = string(runes[:4000])
	}
	if bag, _ := ctx.Value(ctxEvidence).(*evidenceBag); bag != nil {
		id := "mcp:" + r.name
		bag.add(Evidence{EvidenceID: id, Text: out, Origin: OriginMCP, Title: r.name})
	}
	return out, nil
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
