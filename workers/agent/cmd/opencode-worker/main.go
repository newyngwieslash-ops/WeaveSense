package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"loom.local/agent/internal/opencode"
)

func main() {
	cfg := opencode.WorkerConfig{JobsURL: os.Getenv("OPENCODE_JOBS_URL"), WorkerToken: os.Getenv("OPENCODE_WORKER_TOKEN"), RuntimeURL: os.Getenv("OPENCODE_RUNTIME_URL"), RuntimeToken: os.Getenv("OPENCODE_RUNTIME_TOKEN"), BridgeURL: os.Getenv("OPENCODE_BRIDGE_URL"), BridgeControlToken: os.Getenv("OPENCODE_BRIDGE_CONTROL_TOKEN"), ReviewURL: os.Getenv("OPENCODE_REVIEW_URL"), ReviewServiceToken: os.Getenv("AGENT_SERVICE_TOKEN"), ModelName: os.Getenv("OPENCODE_MODEL_NAME")}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := opencode.RunWorkerLoop(ctx, cfg); err != nil && ctx.Err() == nil {
		log.Print("OpenCode worker stopped; check trusted service and runtime state")
		os.Exit(1)
	}
}
