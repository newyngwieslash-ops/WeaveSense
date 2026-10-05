-- Persist retry admission across restarts. No cursor/progress changes.
ALTER TABLE sources ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_error_code text NOT NULL DEFAULT '';
ALTER TABLE keywords ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_error_code text NOT NULL DEFAULT '';
CREATE INDEX sources_retry_due ON sources (next_attempt_at) WHERE enabled;
CREATE INDEX keywords_retry_due ON keywords (next_attempt_at) WHERE enabled;
