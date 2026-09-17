create table if not exists ai_budget_reservations (
  id text primary key,
  job_id text not null unique,
  day text not null,
  price_version text not null,
  reserved_rmb numeric not null,
  status text not null check (status in ('reserved','settled','released','unknown')),
  created_at timestamptz not null default now()
);
create index if not exists ai_budget_reservations_day_idx on ai_budget_reservations(day, price_version);
