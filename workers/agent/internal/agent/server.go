package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type ExecuteFn func(context.Context, ExecuteRequest) (ExecuteResponse, error)

type Server struct {
	cfg     Config
	execute ExecuteFn
	slots   chan struct{}
}

func NewServer(cfg Config, execute ExecuteFn) *Server {
	n := cfg.MaxConcurrent
	if n < 1 {
		n = DefaultConcurrent
	}
	return &Server{
		cfg:     cfg,
		execute: execute,
		slots:   make(chan struct{}, n),
	}
}

func authorized(header, token string) bool {
	if token == "" || !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	got := []byte(strings.TrimPrefix(header, "Bearer "))
	want := []byte(token)
	return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleReady)
	mux.HandleFunc("/v1/execute", s.handleExecute)
	mux.HandleFunc("/v1/review", s.handleReview)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	validEndpoint := func(value string) bool {
		u, err := url.Parse(value)
		return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && u.Fragment == ""
	}
	if s.cfg.ServiceToken == "" || !validEndpoint(s.cfg.ModelBaseURL) || s.cfg.ModelName == "" || s.cfg.ModelAPIKey == "" || s.cfg.ModelTimeout < 0 || s.cfg.ExecutionTimeout < 0 || s.cfg.ModelTimeout > s.cfg.executionTimeout() {
		http.Error(w, `{"ok":false,"error":"unconfigured"}`, http.StatusServiceUnavailable)
		return
	}
	if os.Getenv("AGENT_WORKER_ENABLED") == "true" && (!validEndpoint(s.cfg.DataURL) || s.cfg.DataToken == "") {
		http.Error(w, `{"ok":false,"error":"worker_unconfigured"}`, http.StatusServiceUnavailable)
		return
	}
	ctx := context.Background()
	skillsStatus := "disabled"
	if s.cfg.SkillsDir != "" {
		var err error
		ctx, err = withSkillSnapshot(ctx, s.cfg)
		if err != nil {
			http.Error(w, `{"ok":false,"error":"skills_unreadable"}`, http.StatusServiceUnavailable)
			return
		}
		if _, _, err := loadSkillHandler(ctx, s.cfg); err != nil {
			http.Error(w, `{"ok":false,"error":"skills_invalid"}`, http.StatusServiceUnavailable)
			return
		}
		for _, name := range []string{"industry-analysis", "briefing-writing", "cross-source-check"} {
			if _, err := loadFixedSkill(ctx, s.cfg, name); err != nil {
				http.Error(w, `{"ok":false,"error":"required_skill_unavailable"}`, http.StatusServiceUnavailable)
				return
			}
		}
		skillsStatus = "ready"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "protocol_version": schemaVersion, "skill_snapshot_digest": skillSnapshotDigest(ctx),
		"checks": map[string]string{"configuration": "ready", "skills": skillsStatus, "model_capability": "not_probed", "mcp_capability": "not_probed"},
	})
}

func (s *Server) RunBounded(parent context.Context, req ExecuteRequest) (ExecuteResponse, error) {
	deadline, err := time.Parse(time.RFC3339, req.Policy.DeadlineAt)
	if err != nil || !deadline.After(time.Now()) {
		return fail(req.RunID, "invalid_request", false, false), nil
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return fail(req.RunID, "capacity_exceeded", true, false), fmt.Errorf("capacity_exceeded")
	}
	execDeadline := time.Now().Add(s.cfg.executionTimeout())
	if deadline.Before(execDeadline) {
		execDeadline = deadline
	}
	ctx, cancel := context.WithDeadline(parent, execDeadline)
	defer cancel()
	return s.execute(ctx, req)
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !authorized(r.Header.Get("Authorization"), s.cfg.ServiceToken) {
		writeError(w, http.StatusUnauthorized, "", "unauthorized", false, false)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "too large") || errors.Is(err, io.ErrUnexpectedEOF) {
			status = http.StatusRequestEntityTooLarge
		}
		writeError(w, status, "", "invalid_request", false, false)
		return
	}
	req, err := ParseExecuteRequest(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "", "invalid_request", false, false)
		return
	}
	resp, err := s.RunBounded(r.Context(), req)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, req.RunID, "model_timeout", false, true)
			return
		}
		if strings.Contains(err.Error(), "capacity_exceeded") {
			writeError(w, http.StatusTooManyRequests, req.RunID, "capacity_exceeded", true, false)
			return
		}
		writeError(w, http.StatusBadGateway, req.RunID, "agent_unavailable", true, false)
		return
	}
	if !resp.OK && resp.Error != nil && resp.Error.Code == "invalid_request" {
		writeError(w, http.StatusBadRequest, req.RunID, "invalid_request", false, false)
		return
	}
	resp.RunID = req.RunID
	resp.SchemaVersion = schemaVersion
	if err := ValidateResponse(resp, req.Mode); err != nil {
		writeError(w, http.StatusBadGateway, req.RunID, "invalid_output", false, false)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeError(w http.ResponseWriter, status int, runID, code string, retryable, unknown bool) {
	if runID == "" {
		runID = "00000000-0000-0000-0000-000000000000"
	}
	writeJSON(w, status, ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         runID,
		OK:            false,
		Error: &ExecuteError{
			Code:           code,
			Message:        code,
			Retryable:      retryable,
			OutcomeUnknown: unknown,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, `{"ok":false}`, http.StatusInternalServerError)
		return
	}
	if len(body) > MaxResponseBytes {
		http.Error(w, `{"ok":false,"error":{"code":"invalid_output"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (s *Server) ListenAndServe() error {
	httpSrv := &http.Server{
		Addr:              s.cfg.ListenAddr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      s.cfg.executionTimeout() + 10*time.Second,
	}
	log.Printf("agent listening on %s", s.cfg.ListenAddr)
	return httpSrv.ListenAndServe()
}
