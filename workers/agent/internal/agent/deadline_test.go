package agent

import (
	"context"
	"testing"
	"time"
)

func TestBoundedExecutionUsesConfiguredTimeout(t *testing.T) {
	cfg := testConfig()
	cfg.ExecutionTimeout = 90 * time.Second
	var observed time.Duration
	srv := NewServer(cfg, func(ctx context.Context, _ ExecuteRequest) (ExecuteResponse, error) {
		deadline, _ := ctx.Deadline()
		observed = time.Until(deadline)
		return successStub(), nil
	})
	req, err := ParseExecuteRequest(validAnalyzeJSON())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = srv.RunBounded(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if observed < 89*time.Second || observed > 90*time.Second {
		t.Fatalf("configured deadline: %v", observed)
	}
}

func TestTimeoutConfigRejectsUnboundedValues(t *testing.T) {
	t.Setenv("AGENT_SERVICE_TOKEN", "test")
	t.Setenv("AGENT_MODEL_BASE_URL", "http://127.0.0.1:9/v1")
	t.Setenv("AGENT_MODEL_NAME", "fake")
	t.Setenv("AGENT_MODEL_API_KEY", "fake")
	for _, raw := range []string{"0", "-1", "NaN", "900001"} {
		t.Setenv("AGENT_EXECUTE_TIMEOUT_MS", raw)
		if _, err := LoadConfig(); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	t.Setenv("AGENT_EXECUTE_TIMEOUT_MS", "120000")
	t.Setenv("AGENT_MODEL_TIMEOUT_MS", "30000")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ExecutionTimeout != 120*time.Second || cfg.ModelTimeout != 30*time.Second {
		t.Fatalf("timeouts: %+v", cfg)
	}
}

func TestModelTimeoutHonorsRemainingExecutionTime(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	left := remainingModelDeadline(ctx, Config{ModelTimeout: 60 * time.Second})
	if left > 10*time.Second || left < 9*time.Second {
		t.Fatalf("remaining: %v", left)
	}
	if left = remainingModelDeadline(context.Background(), Config{ModelTimeout: 60 * time.Second}); left != 60*time.Second {
		t.Fatalf("configured model timeout: %v", left)
	}
}
