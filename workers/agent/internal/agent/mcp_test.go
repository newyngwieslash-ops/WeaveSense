package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func TestMCPAllowlistAndEmptyList(t *testing.T) {
	mcpSrv := mcpserver.NewMCPServer("compat", "1.0.0")
	mcpSrv.AddTool(mcp.NewTool("search", mcp.WithDescription("search")), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultText("ok"), nil
	})
	mcpSrv.AddTool(mcp.NewTool("write", mcp.WithDescription("write")), func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultText("no"), nil
	})
	httpSrv := mcpserver.NewTestStreamableHTTPServer(mcpSrv)
	t.Cleanup(httpSrv.Close)

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "mcp.json")
	body := `{"servers":[{"id":"research","enabled":true,"url":"` + httpSrv.URL + `/mcp","transport":"streamable_http","allowed_tools":["search"],"required":false}]}`
	if err := os.WriteFile(cfgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	tools, warnings, err := loadMCPTools(context.Background(), Config{MCPConfigPath: cfgPath}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("%v", warnings)
	}
	if len(tools) != 1 {
		t.Fatalf("tools %d", len(tools))
	}
	info, _ := tools[0].Info(context.Background())
	if info.Name != "mcp_research_search" {
		t.Fatalf("name %s", info.Name)
	}

	emptyPath := filepath.Join(dir, "empty.json")
	_ = os.WriteFile(emptyPath, []byte(`{"servers":[{"id":"research","enabled":true,"url":"`+httpSrv.URL+`/mcp","transport":"streamable_http","allowed_tools":[],"required":false}]}`), 0o644)
	tools, _, err = loadMCPTools(context.Background(), Config{MCPConfigPath: emptyPath}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 0 {
		t.Fatalf("empty allowlist leaked %d tools", len(tools))
	}
}

func TestMCPOptionalFailureWarns(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "mcp.json")
	_ = os.WriteFile(cfgPath, []byte(`{"servers":[{"id":"research","enabled":true,"url":"http://127.0.0.1:1/mcp","transport":"streamable_http","allowed_tools":["search"],"required":false}]}`), 0o644)
	_, warnings, err := loadMCPTools(context.Background(), Config{MCPConfigPath: cfgPath}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) == 0 {
		t.Fatal("expected warning")
	}
}
