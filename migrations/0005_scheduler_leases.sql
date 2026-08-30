alter table sources add column if not exists claim_token text not null default '';
alter table sources add column if not exists claimed_at timestamptz;
alter table keywords add column if not exists claim_token text not null default '';
alter table keywords add column if not exists claimed_at timestamptz;

create index if not exists sources_scheduler_lease_idx
  on sources (claimed_at) where enabled = true and status = 'running';
create index if not exists keywords_scheduler_lease_idx
  on keywords (claimed_at) where enabled = true and status = 'running';
