do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'ai_jobs') then
    alter table ai_jobs add column if not exists request_id text;
    create unique index if not exists ai_jobs_request_id_unique on ai_jobs(request_id) where request_id is not null;
  end if;
  if exists (select 1 from information_schema.tables where table_name = 'agent_checkpoints') then
    alter table agent_checkpoints add column if not exists lease_until timestamptz;
  end if;
end $$;
