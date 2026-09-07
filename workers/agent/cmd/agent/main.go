package main

import (
	"context"
	"fmt"
	"os"

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
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func healthcheck() int {
	return 0
}
