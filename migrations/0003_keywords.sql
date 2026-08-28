create table if not exists keywords (
  id text primary key,
  phrase text not null,
  platforms jsonb not null default '[]'::jsonb,
  interval_minutes integer not null default 30,
  enabled boolean not null default true,
  last_scanned_at timestamptz,
  last_error text not null default '',
  status text not null default 'idle',
  hits integer not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists keywords_phrase_lower on keywords (lower(phrase));
create index if not exists keywords_enabled_idx on keywords (enabled);

alter table items add column if not exists matched_keywords jsonb not null default '[]'::jsonb;
alter table jobs add column if not exists keyword_id text not null default '';

create index if not exists jobs_keyword_idx on jobs (keyword_id);
