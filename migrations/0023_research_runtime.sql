alter table ai_runs drop constraint if exists ai_runs_provider_check;
alter table ai_runs add constraint ai_runs_provider_check check (provider in ('legacy','eino','opencode'));
alter table ai_runs add constraint ai_runs_opencode_research_check check (provider <> 'opencode' or mode='research');

alter table ai_jobs add column runtime_provider text;

-- Stop rather than guess ownership: the transaction runner rolls back all DDL.
do $$
declare bad_ids text;
begin
  select string_agg(j.id, ', ' order by j.id) into bad_ids
  from ai_jobs j left join ai_runs r on r.id=j.run_id
  where jsonb_typeof(j.payload) <> 'object'
    or (j.run_id is not null and (
      r.id is null or r.provider not in ('eino','opencode')
      or r.mode <> case when j.item_id like 'research:%' then 'research' else 'analyze_item' end
      or jsonb_typeof(r.request_json) <> 'object'
      or (r.request_json ? 'provider' and r.request_json->>'provider' is distinct from r.provider)
      or (r.request_json ? 'mode' and r.request_json->>'mode' is distinct from r.mode)
      or (j.payload ? 'provider' and j.payload->>'provider' is distinct from r.provider)
      or (j.payload ? 'mode' and j.payload->>'mode' is distinct from r.mode)))
    or (j.run_id is null and (
      (j.item_id not like 'research:%' and j.payload='{}'::jsonb)
      or (j.item_id like 'research:%' and j.payload->>'provider'='eino' and j.payload->>'mode'='research')) is not true);
  if bad_ids is not null then raise exception 'unprovable research runtime ownership for job IDs: %', bad_ids; end if;
end $$;

update ai_jobs j set runtime_provider = case when j.run_id is null then 'eino' else r.provider end
from (select j0.id,r0.provider from ai_jobs j0 left join ai_runs r0 on r0.id=j0.run_id) r
where j.id=r.id;
alter table ai_jobs alter column runtime_provider set not null;
alter table ai_jobs alter column runtime_provider set default 'eino';
alter table ai_jobs add constraint ai_jobs_runtime_provider_check check (runtime_provider in ('eino','opencode'));
alter table ai_jobs add constraint ai_jobs_opencode_research_check check (runtime_provider <> 'opencode' or item_id like 'research:%');
create index ai_jobs_runtime_claim_idx on ai_jobs(runtime_provider,status,next_attempt_at);

create table ai_runtime_bindings (
  run_id text primary key references ai_runs(id),
  provider text not null check (provider='opencode'),
  runtime_version text not null,
  config_digest text not null check (config_digest ~ '^[a-f0-9]{64}$'),
  instance_id text not null,
  epoch text not null check (epoch ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  session_id text not null,
  dispatch_id text not null,
  state text not null default 'prepared' check (state in ('prepared','dispatching','submitted','candidate_saved','dispatch_unknown','aborted')),
  last_observed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique(instance_id,epoch,session_id),
  unique(instance_id,epoch,dispatch_id)
);
