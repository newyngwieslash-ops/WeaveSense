-- T09: persistent time-window admission for the heavy production stages.
--
-- The scheduler tick is about to run more often (a 60 s wake-up instead of 30
-- minutes) so that collection due-times are honoured promptly. The heavy stages
-- that ride along in the same tick (media ingest, OCR/ASR extraction, paid
-- reconciliation) must NOT scale up with it: running them every 60 s instead of
-- every 30 minutes would multiply落盘/OCR/付费对账频率 by 30.
--
-- Admission is therefore claimed per (stage, window) in the database rather than
-- in process memory: a restarted or duplicated scheduler must not be able to
-- re-run a stage in a window that already ran. `window_key` is the period start
-- in the stage's own interval, so re-entering the same period always collides.
create table if not exists stage_windows (
  stage text not null,
  window_key text not null,
  -- 'claimed' while a run is in flight, 'done'/'failed' once it settles.
  status text not null check (status in ('claimed', 'done', 'failed')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Free-text, non-sensitive outcome summary (counts only).
  note text not null default '',
  primary key (stage, window_key)
);

create index if not exists stage_windows_status_idx on stage_windows (stage, status);

-- Reclaim support: a process killed mid-stage leaves 'claimed' forever otherwise.
create index if not exists stage_windows_claimed_idx on stage_windows (stage, claimed_at);
