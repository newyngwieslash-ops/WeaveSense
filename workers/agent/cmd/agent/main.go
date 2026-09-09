package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"loom.local/agent/internal/agent"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	cfg, err := agent.LoadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	srv := agent.NewServer(cfg, func(ctx context.Context, req agent.ExecuteRequest) (agent.ExecuteResponse, error) {
		return agent.Execute(ctx, cfg, req)
	})
	if os.Getenv("AGENT_WORKER_ENABLED") == "true" {
		go agent.RunWorkerLoop(context.Background(), cfg, srv.RunBounded)
	}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func healthcheck() int {
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Get("http://127.0.0.1:8791/healthz")
	if err != nil || res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
