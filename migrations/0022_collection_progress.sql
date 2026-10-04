-- Progress is committed with the source claim only after all returned items save.
alter table sources add column if not exists scan_state jsonb not null default '{"bootstrap":"latest"}'::jsonb;
alter table sources add column if not exists has_more boolean not null default false;
alter table sources add column if not exists collection_coverage jsonb;
alter table sources add column if not exists rejected_entries integer not null default 0;

-- Conflict evidence contains identities only, never credentials or message bodies.
create table if not exists collection_identity_conflicts (
  id bigint generated always as identity primary key,
  source_id text not null,
  kind text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now()
);
-- Merged rows remain recoverable; business references are rebound before removal.
create table if not exists collection_identity_merges (
  id bigint generated always as identity primary key,
  source_id text not null,
  old_item_id text not null,
  new_item_id text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
