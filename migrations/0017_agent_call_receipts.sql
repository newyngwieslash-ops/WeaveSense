alter table ai_budget_reservations add column if not exists dispatch_state text not null default 'unconfirmed';
alter table ai_budget_reservations add column if not exists actual_rmb numeric;
alter table ai_budget_reservations add column if not exists settled_at timestamptz;
alter table ai_budget_reservations add column if not exists pricing jsonb not null default '{}'::jsonb;
create table if not exists ai_model_calls (
  run_id text not null references ai_runs(id), call_id text not null,
  model text not null, policy_version text not null, execution_day text not null,
  state text not null check (state in ('started','completed','unknown','not_sent')),
  input_tokens bigint, output_tokens bigint,
  started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
  primary key (run_id,call_id),
  check (input_tokens is null or input_tokens >= 0), check (output_tokens is null or output_tokens >= 0)
);
