create table if not exists sources (
  id text primary key,
  platform text not null,
  name text not null,
  handle text not null default '',
  url text not null default '',
  feed_url text not null default '',
  interval_minutes integer not null default 30,
  enabled boolean not null default true,
  last_external_id text not null default '',
  last_published_at timestamptz,
  last_scanned_at timestamptz,
  last_error text not null default '',
  status text not null default 'idle',
  adapter text not null default 'rss',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists sources_platform_idx on sources (platform);
create index if not exists sources_enabled_idx on sources (enabled);

create table if not exists items (
  id text primary key,
  source_id text not null,
  platform text not null,
  external_id text not null,
  title text not null default '',
  body text not null default '',
  author text not null default '',
  url text not null default '',
  media_type text not null default 'article',
  media_urls jsonb not null default '[]'::jsonb,
  thumbnail_url text not null default '',
  views integer,
  likes integer,
  published_at timestamptz,
  collected_at timestamptz not null default now(),
  pipeline_status text not null default 'ingested',
  extra jsonb not null default '{}'::jsonb,
  unique (source_id, external_id)
);

create index if not exists items_source_idx on items (source_id);
create index if not exists items_platform_idx on items (platform);
create index if not exists items_published_idx on items (published_at desc);
create index if not exists items_collected_idx on items (collected_at desc);
create index if not exists items_pipeline_idx on items (pipeline_status);

create table if not exists jobs (
  id text primary key,
  source_id text not null,
  platform text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  items_found integer not null default 0,
  items_new integer not null default 0,
  error text not null default '',
  kind text not null default 'incremental'
);

create index if not exists jobs_started_idx on jobs (started_at desc);
create index if not exists jobs_source_idx on jobs (source_id);

create table if not exists analyses (
  id text primary key,
  item_id text not null,
  summary text not null default '',
  topics jsonb not null default '[]'::jsonb,
  entities jsonb not null default '[]'::jsonb,
  insights text not null default '',
  tags jsonb not null default '[]'::jsonb,
  model text not null default 'grok-4.5',
  created_at timestamptz not null default now()
);

create index if not exists analyses_item_idx on analyses (item_id);
create index if not exists analyses_created_idx on analyses (created_at desc);

create table if not exists knowledge_notes (
  id text primary key,
  title text not null,
  content text not null,
  kind text not null default 'briefing',
  item_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_created_idx on knowledge_notes (created_at desc);

create table if not exists app_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
