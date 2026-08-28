create table if not exists media_objects (
  id text primary key,
  item_id text not null,
  source_url text not null default '',
  object_key text not null default '',
  public_url text not null default '',
  content_type text not null default '',
  bytes integer,
  sha256 text not null default '',
  kind text not null default 'file',
  status text not null default 'remote',
  error text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists media_item_idx on media_objects (item_id);
create index if not exists media_status_idx on media_objects (status);

create table if not exists extract_jobs (
  id text primary key,
  item_id text not null,
  media_id text not null default '',
  kind text not null,
  status text not null default 'pending',
  result_text text not null default '',
  model text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists extract_item_idx on extract_jobs (item_id);
create index if not exists extract_status_idx on extract_jobs (status);
