create table if not exists ai_jobs (
  id text primary key,
  item_id text not null,
  material_hash text not null,
  policy_version text not null,
  status text not null check (status in ('queued','running','succeeded','failed','outcome_unknown')),
  run_id text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token text not null default '',
  error_code text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, material_hash, policy_version)
);
create index if not exists ai_jobs_claim_idx on ai_jobs(status, next_attempt_at);

create table if not exists ai_budget_days (
  day text not null,
  price_version text not null,
  reserved_count integer not null default 0,
  reserved_rmb numeric not null default 0,
  settled_count integer not null default 0,
  settled_rmb numeric not null default 0,
  primary key (day, price_version)
);
