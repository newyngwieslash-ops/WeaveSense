create table if not exists reconciliation_queue (
  source_id text primary key check (source_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text not null default ''
);

create index if not exists reconciliation_queue_created_idx
  on reconciliation_queue (next_attempt_at, updated_at, source_id);
