-- Historical observations stay unknown; do not backfill request times as content progress.
alter table sources add column if not exists last_content_at timestamptz;
alter table jobs add column if not exists adapter text;
alter table jobs add column if not exists error_code text;
alter table jobs add column if not exists duration_ms bigint;
alter table jobs add column if not exists items_updated integer;
alter table jobs add column if not exists items_invalid integer;
alter table jobs add column if not exists bytes bigint;
alter table jobs add column if not exists coverage jsonb;
alter table jobs add column if not exists retry_at timestamptz;
alter table jobs alter column items_found drop not null;
alter table jobs alter column items_new drop not null;
