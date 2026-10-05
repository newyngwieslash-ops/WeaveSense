alter table media_objects
  add column attempts integer not null default 0 check (attempts >= 0),
  add column next_attempt_at timestamptz,
  add column claim_token text not null default '',
  add column claimed_at timestamptz;

-- Existing error rows remain paused until an explicit single-row replay.
create index media_retry_due_idx on media_objects(next_attempt_at,created_at,id)
  where status in ('remote','error');
create index media_lease_idx on media_objects(claimed_at)
  where status='running';
