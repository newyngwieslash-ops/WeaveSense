-- 0027: assistant runtime plumbing (plan §5.1/§4.2).
-- ai_jobs gains an explicit job_kind; assistant jobs keep item_id
-- compatibility via the 'assistant:<turn_id>' convention, but dispatch is
-- decided by job_kind, never by the item_id prefix alone. The assistant mode
-- travels as ai_runs.mode='research' with provider='opencode' (existing CHECK
-- allowlist) plus job_kind='assistant' on the job — old analyze/research rows
-- are not rewritten.

-- 1. job_kind: analyze_item | research | assistant. Unknown rows must fail
--    the whole migration (validated below), never guessed.
alter table ai_jobs add column job_kind text;
update ai_jobs set job_kind = case when item_id like 'research:%' then 'research' else 'analyze_item' end;
alter table ai_jobs alter column job_kind set not null;
alter table ai_jobs add constraint ai_jobs_kind_check check (job_kind in ('analyze_item','research','assistant'));

-- 2. Ownership proof, mirroring 0023: payload/provider/mode must prove the
--    classification the backfill will write. Any unprovable row fails the
--    whole migration and reports IDs (no guessing, no silent rewrite).
do $$
declare bad_ids text;
begin
  select string_agg(j.id, ', ' order by j.id) into bad_ids
  from ai_jobs j left join ai_runs r on r.id = j.run_id
  where jsonb_typeof(j.payload) <> 'object'
    or (j.run_id is not null and (
      r.id is null or r.provider not in ('eino','opencode')
      or (j.item_id like 'research:%') is distinct from (r.mode = 'research')
      or jsonb_typeof(r.request_json) <> 'object'
      or (r.request_json ? 'provider' and r.request_json->>'provider' is distinct from r.provider)
      or (r.request_json ? 'mode' and r.request_json->>'mode' is distinct from r.mode)
      or (j.payload ? 'provider' and j.payload->>'provider' is distinct from r.provider)
      or (j.payload ? 'mode' and j.payload->>'mode' is distinct from r.mode)))
    or (j.run_id is null and j.payload <> '{}'::jsonb);
  if bad_ids is not null then raise exception 'unprovable ai_jobs classification for job IDs: %', bad_ids; end if;
end $$;

-- 3. opencode may only ever run research or assistant jobs (assistant rows are
--    opencode-only by construction above); analyze_item stays on legacy/eino.
alter table ai_jobs drop constraint if exists ai_jobs_opencode_research_check;
alter table ai_jobs add constraint ai_jobs_opencode_research_check
  check (runtime_provider <> 'opencode' or job_kind in ('research','assistant'));
alter table ai_jobs add constraint ai_jobs_assistant_shape_check
  check (job_kind <> 'assistant' or (item_id like 'assistant:%' and runtime_provider = 'opencode'));

-- CHECK constraints cannot hold subqueries, so the "assistant job must link a
-- real assistant turn" rule lives in a constraint trigger (plan §5.1).
create function reject_unlinked_assistant_job() returns trigger language plpgsql as $$
begin
  if new.job_kind = 'assistant' then
    if new.runtime_provider <> 'opencode'
       or new.item_id not like 'assistant:%'
       or not exists (select 1 from assistant_turns t where t.id = substring(new.item_id from 11)) then
      raise exception 'assistant job % does not link a real assistant_turn row', new.id;
    end if;
  end if;
  return new;
end $$;
create trigger assistant_job_turn_binding before insert or update on ai_jobs
  for each row execute function reject_unlinked_assistant_job();

-- 4. Runtime binding facts for the assistant stop-protocol (§4.4):
--    'result_saved' is assistant-only; 'candidate_saved' stays research-only.
alter table ai_runtime_bindings drop constraint ai_runtime_bindings_state_check;
alter table ai_runtime_bindings add constraint ai_runtime_bindings_state_check
  check (state in ('prepared','dispatching','submitted','candidate_saved','result_saved','dispatch_unknown','aborted'));
alter table ai_runtime_bindings add column runtime_stopped_at timestamptz;
alter table ai_runtime_bindings add column stop_receipt_json jsonb
  check (stop_receipt_json is null or jsonb_typeof(stop_receipt_json)='object');

-- 5. Queue helpers: assistant claims pull only assistant jobs.
create index ai_jobs_kind_claim_idx on ai_jobs(job_kind, status, next_attempt_at);
