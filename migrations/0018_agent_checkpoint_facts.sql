alter table agent_checkpoints add column if not exists updated_at timestamptz not null default clock_timestamp();
alter table agent_checkpoints add column if not exists model_call_count integer not null default 0;
alter table agent_checkpoints add column if not exists evidence_event_count integer not null default 0;
