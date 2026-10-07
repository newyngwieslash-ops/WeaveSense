create table ai_research_candidates (
  run_id text primary key references ai_runs(id),
  result_json jsonb not null,
  evidence_json jsonb not null,
  candidate_digest text not null check (candidate_digest ~ '^[a-f0-9]{64}$'),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  frozen_policy jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create function reject_research_candidate_mutation() returns trigger language plpgsql as $$
begin raise exception 'research candidate is immutable'; end $$;
create trigger research_candidate_immutable before update or delete on ai_research_candidates
  for each row execute function reject_research_candidate_mutation();

create table ai_research_reviews (
  run_id text primary key references ai_research_candidates(run_id),
  candidate_digest text not null,
  evidence_digest text not null,
  policy_digest text not null,
  state text not null default 'pending' check (state in ('pending','running','completed','unknown','failed')),
  report_json jsonb,
  review_call_id text unique,
  request_digest text,
  grant_nonce text,
  grant_hash text,
  claim_token text,
  expires_at timestamptz,
  error_code text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
