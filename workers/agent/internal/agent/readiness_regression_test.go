package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestReadinessRejectsConfigurationWithoutExecution(t *testing.T) {
	t.Setenv("AGENT_WORKER_ENABLED", "false")
	invalidSkills := t.TempDir()
	writeSkill(t, invalidSkills, "bad", "---\nname: bad\ndescription: test\ncontext: fork\n---\nbody")
	for _, scenario := range []string{"service", "model_url", "model_name", "model_key", "missing_skills", "invalid_skills"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := testConfig()
			switch scenario {
			case "service":
				cfg.ServiceToken = ""
			case "model_url":
				cfg.ModelBaseURL = ""
			case "model_name":
				cfg.ModelName = ""
			case "model_key":
				cfg.ModelAPIKey = ""
			case "missing_skills":
				cfg.SkillsDir = filepath.Join(t.TempDir(), "missing")
			case "invalid_skills":
				cfg.SkillsDir = invalidSkills
			}
			calls := 0
			srv := NewServer(cfg, func(context.Context, ExecuteRequest) (ExecuteResponse, error) { calls++; return ExecuteResponse{}, nil })
			for path, status := range map[string]int{"/healthz": 200, "/readyz": 503} {
				out := httptest.NewRecorder()
				srv.Handler().ServeHTTP(out, httptest.NewRequest(http.MethodGet, path, nil))
				if out.Code != status {
					t.Fatalf("%s returned %d", path, out.Code)
				}
			}
			if calls != 0 {
				t.Fatal("health check executed model")
			}
		})
	}
	for _, missing := range []string{"AGENT_SERVICE_TOKEN", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_NAME", "AGENT_MODEL_API_KEY"} {
		t.Run("startup_"+missing, func(t *testing.T) {
			for _, name := range []string{"AGENT_SERVICE_TOKEN", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_NAME", "AGENT_MODEL_API_KEY"} {
				t.Setenv(name, "fake")
			}
			t.Setenv(missing, "")
			if _, err := LoadConfig(); err == nil {
				t.Fatal("missing required config accepted")
			}
		})
	}
}
