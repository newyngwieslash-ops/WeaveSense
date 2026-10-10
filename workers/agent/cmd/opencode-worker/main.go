package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"loom.local/agent/internal/opencode"
)

func main() {
	cfg := opencode.WorkerConfig{JobsURL: os.Getenv("OPENCODE_JOBS_URL"), WorkerToken: os.Getenv("OPENCODE_WORKER_TOKEN"), RuntimeURL: os.Getenv("OPENCODE_RUNTIME_URL"), RuntimeToken: os.Getenv("OPENCODE_RUNTIME_TOKEN"), BridgeURL: os.Getenv("OPENCODE_BRIDGE_URL"), BridgeControlToken: os.Getenv("OPENCODE_BRIDGE_CONTROL_TOKEN"), ReviewURL: os.Getenv("OPENCODE_REVIEW_URL"), ReviewServiceToken: os.Getenv("AGENT_SERVICE_TOKEN"), ModelName: os.Getenv("OPENCODE_MODEL_NAME")}
	assistantCfg := cfg
	// The assistant claim posts to the dedicated assistant-jobs route with
	// the same shared worker secret (§4.2: separate URL, one trust domain).
	assistantCfg.JobsURL = os.Getenv("ASSISTANT_JOBS_URL")
	if assistantCfg.JobsURL == "" {
		assistantCfg.JobsURL = cfg.JobsURL
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// Alternating two-queue scheduling (§4.2): one research pass, one
	// assistant pass, forever — neither queue starves the other. A queue
	// being UNAVAILABLE (research not configured on this host) must not
	// kill the worker: it is a permanent, benign condition for that queue,
	// so it logs once and keeps the other queue alive. Real execution
	// errors still stop the worker.
	researchUnavailable := false
	assistantUnavailable := false
	for {
		if err := opencode.RunWorkerLoopOnce(ctx, cfg); err != nil && ctx.Err() == nil {
			if strings.Contains(err.Error(), "opencode_claim_unavailable") {
				if !researchUnavailable { log.Printf("[worker] research queue unavailable on this host; assistant queue continues"); researchUnavailable = true }
			} else {
				log.Printf("OpenCode worker stopped (research queue): %v", err)
				os.Exit(1)
			}
		} else {
			researchUnavailable = false
		}
		if err := opencode.RunAssistantWorkerOnce(ctx, assistantCfg); err != nil && ctx.Err() == nil {
			if strings.Contains(err.Error(), "assistant_claim_unavailable") {
				if !assistantUnavailable { log.Printf("[worker] assistant queue unavailable on this host; research queue continues"); assistantUnavailable = true }
			} else {
				log.Printf("OpenCode worker stopped (assistant queue): %v", err)
				os.Exit(1)
			}
		} else {
			assistantUnavailable = false
		}
		time.Sleep(2 * time.Second)
	}
}
