create table if not exists ai_runs (
  id text primary key,
  request_id text not null unique,
  mode text not null check (mode in ('analyze_item','briefing','research')),
  provider text not null check (provider in ('legacy','eino')),
  input_hash text not null,
  material_hash text not null,
  policy_version text not null,
  request_json jsonb not null,
  status text not null check (status in ('running','succeeded','failed','timed_out','cancelled')),
  claim_token text not null,
  data_token_hash text not null default '',
  expires_at timestamptz not null,
  response_json jsonb,
  events_json jsonb not null default '[]'::jsonb,
  model text not null default '',
  prompt_version text not null default '',
  skill_versions jsonb not null default '{}'::jsonb,
  input_tokens bigint,
  output_tokens bigint,
  model_calls integer not null default 0,
  tool_calls integer not null default 0,
  error_code text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_runs_status_expiry_idx on ai_runs(status, expires_at);
alter table analyses add column if not exists run_id text references ai_runs(id);
alter table knowledge_notes add column if not exists run_id text references ai_runs(id);
create unique index if not exists analyses_run_unique on analyses(run_id) where run_id is not null;
create unique index if not exists knowledge_notes_run_unique on knowledge_notes(run_id) where run_id is not null;
