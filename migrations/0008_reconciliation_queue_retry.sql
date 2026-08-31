alter table reconciliation_queue add column if not exists updated_at timestamptz;
alter table reconciliation_queue add column if not exists next_attempt_at timestamptz;

update reconciliation_queue
set updated_at = coalesce(updated_at, created_at, now()),
    next_attempt_at = coalesce(next_attempt_at, created_at, now())
where updated_at is null or next_attempt_at is null;

alter table reconciliation_queue alter column updated_at set default now();
alter table reconciliation_queue alter column updated_at set not null;
alter table reconciliation_queue alter column next_attempt_at set default now();
alter table reconciliation_queue alter column next_attempt_at set not null;

drop index if exists reconciliation_queue_created_idx;
create index reconciliation_queue_created_idx
  on reconciliation_queue (next_attempt_at, updated_at, source_id);
