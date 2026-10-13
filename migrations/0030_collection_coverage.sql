alter table jobs add column if not exists coverage jsonb not null default '{}'::jsonb;
