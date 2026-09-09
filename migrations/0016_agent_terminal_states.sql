alter table ai_runs drop constraint if exists ai_runs_status_check;
alter table ai_runs add constraint ai_runs_status_check
  check (status in ('running','succeeded','failed','outcome_unknown','timed_out','cancelled'));
create unique index if not exists ai_jobs_run_unique on ai_jobs(run_id) where run_id is not null;
