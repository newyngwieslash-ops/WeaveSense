alter table jobs add column if not exists provider text not null default '';
alter table jobs add column if not exists attempts jsonb not null default '[]'::jsonb;
alter table jobs add column if not exists paid_call boolean not null default false;
