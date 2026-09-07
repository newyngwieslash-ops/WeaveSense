create table if not exists agent_checkpoints (
  check_point_id text primary key,
  run_id text not null,
  claim_token text not null,
  sequence integer not null default 0,
  schema_version text not null,
  runtime_version text not null,
  payload bytea not null,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);
create index if not exists agent_checkpoints_run_idx on agent_checkpoints(run_id);
