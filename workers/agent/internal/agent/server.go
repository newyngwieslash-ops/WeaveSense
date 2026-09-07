package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type ExecuteFn func(context.Context, ExecuteRequest) (ExecuteResponse, error)

type Server struct {
	cfg      Config
	execute  ExecuteFn
	slots    chan struct{}
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
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	if s.cfg.ServiceToken == "" || s.cfg.ModelBaseURL == "" || s.cfg.ModelName == "" {
		http.Error(w, `{"ok":false,"error":"unconfigured"}`, http.StatusServiceUnavailable)
		return
	}
	if s.cfg.SkillsDir != "" {
		if st, err := os.Stat(s.cfg.SkillsDir); err != nil || !st.IsDir() {
			http.Error(w, `{"ok":false,"error":"skills_unreadable"}`, http.StatusServiceUnavailable)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
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
	deadline, err := time.Parse(time.RFC3339, req.Policy.DeadlineAt)
	if err != nil || !deadline.After(time.Now()) {
		writeError(w, http.StatusBadRequest, req.RunID, "invalid_request", false, false)
		return
	}

	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		writeError(w, http.StatusTooManyRequests, req.RunID, "capacity_exceeded", true, false)
		return
	}

	execDeadline := time.Now().Add(ExecuteTimeout)
	if deadline.Before(execDeadline) {
		execDeadline = deadline
	}
	ctx, cancel := context.WithDeadline(r.Context(), execDeadline)
	defer cancel()

	resp, err := s.execute(ctx, req)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, req.RunID, "model_timeout", false, true)
			return
		}
		writeError(w, http.StatusBadGateway, req.RunID, "agent_unavailable", true, false)
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
		WriteTimeout:      50 * time.Second,
	}
	log.Printf("agent listening on %s", s.cfg.ListenAddr)
	return httpSrv.ListenAndServe()
}
