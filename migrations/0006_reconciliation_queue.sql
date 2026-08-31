create table if not exists reconciliation_queue (
  source_id text primary key,
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text not null default ''
);

create index if not exists reconciliation_queue_created_idx
  on reconciliation_queue (created_at, source_id);
