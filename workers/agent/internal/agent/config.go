package agent

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	MaxRequestBytes   = 512 * 1024
	MaxResponseBytes  = 256 * 1024
	DefaultListen     = "0.0.0.0:8791"
	DefaultConcurrent = 2
	ExecuteTimeout    = 40 * time.Second
)

type Config struct {
	ListenAddr    string
	ServiceToken  string
	ModelBaseURL  string
	ModelName     string
	ModelAPIKey   string
	MaxConcurrent int
	SkillsDir     string
	MCPConfigPath string
	DataURL       string
	DataToken     string
}

func LoadConfig() (Config, error) {
	cfg := Config{
		ListenAddr:    getenv("AGENT_LISTEN_ADDR", DefaultListen),
		ServiceToken:  strings.TrimSpace(os.Getenv("AGENT_SERVICE_TOKEN")),
		ModelBaseURL:  strings.TrimSpace(os.Getenv("AGENT_MODEL_BASE_URL")),
		ModelName:     strings.TrimSpace(os.Getenv("AGENT_MODEL_NAME")),
		ModelAPIKey:   strings.TrimSpace(os.Getenv("AGENT_MODEL_API_KEY")),
		SkillsDir:     strings.TrimSpace(os.Getenv("AGENT_SKILLS_DIR")),
		MCPConfigPath: strings.TrimSpace(os.Getenv("AGENT_MCP_CONFIG")),
		DataURL:       strings.TrimSpace(os.Getenv("AGENT_DATA_URL")),
		DataToken:     strings.TrimSpace(os.Getenv("AGENT_DATA_TOKEN")),
		MaxConcurrent: DefaultConcurrent,
	}
	if raw := strings.TrimSpace(os.Getenv("AGENT_MAX_CONCURRENT_RUNS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 32 {
			return cfg, fmt.Errorf("invalid AGENT_MAX_CONCURRENT_RUNS")
		}
		cfg.MaxConcurrent = n
	}
	if cfg.ServiceToken == "" {
		return cfg, fmt.Errorf("AGENT_SERVICE_TOKEN is required")
	}
	if cfg.ModelBaseURL == "" || cfg.ModelName == "" || cfg.ModelAPIKey == "" {
		return cfg, fmt.Errorf("AGENT_MODEL_BASE_URL, AGENT_MODEL_NAME and AGENT_MODEL_API_KEY are required")
	}
	return cfg, nil
}

func getenv(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}
