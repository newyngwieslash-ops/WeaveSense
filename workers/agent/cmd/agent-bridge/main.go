package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"loom.local/agent/internal/opencode"
)

func main() {
	required := []string{"OPENCODE_BRIDGE_CONTROL_TOKEN", "AGENT_DATA_URL", "AGENT_DATA_TOKEN", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_NAME"}
	for _, name := range required {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			log.Fatalf("required configuration missing: %s", name)
		}
	}
	for _, name := range []string{"AGENT_DATA_URL", "AGENT_MODEL_BASE_URL"} {
		u, err := url.Parse(os.Getenv(name))
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			log.Fatalf("invalid endpoint configuration: %s", name)
		}
	}
	timeout := 120000
	if raw := os.Getenv("AGENT_EXECUTE_TIMEOUT_MS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1000 || n > 900000 {
			log.Fatal("invalid AGENT_EXECUTE_TIMEOUT_MS")
		}
		timeout = n
	}
	model := os.Getenv("AGENT_MODEL_NAME")
	modelTimeout := 30000
	if raw := os.Getenv("AGENT_MODEL_TIMEOUT_MS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1000 || n > 900000 {
			log.Fatal("invalid AGENT_MODEL_TIMEOUT_MS")
		}
		modelTimeout = n
	}
	if modelTimeout > timeout {
		log.Fatal("AGENT_MODEL_TIMEOUT_MS exceeds AGENT_EXECUTE_TIMEOUT_MS")
	}
	bridge := opencode.NewBridge(opencode.BridgeConfig{AppDataURL: os.Getenv("AGENT_DATA_URL"), AppServiceToken: os.Getenv("AGENT_DATA_TOKEN"), ControlToken: os.Getenv("OPENCODE_BRIDGE_CONTROL_TOKEN"), AllowedModel: model})
	mux := http.NewServeMux()
	mux.Handle("/v1/chat/completions", opencode.NewModelProxy(bridge, opencode.ModelProxyConfig{BaseURL: os.Getenv("AGENT_MODEL_BASE_URL"), APIKey: os.Getenv("AGENT_MODEL_API_KEY"), ModelName: model, ModelTimeout: time.Duration(modelTimeout) * time.Millisecond}))
	mux.Handle("/", bridge.Handler())
	srv := &http.Server{Addr: ":8792", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: time.Duration(timeout+10000) * time.Millisecond, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Fatal(srv.ListenAndServe())
}
