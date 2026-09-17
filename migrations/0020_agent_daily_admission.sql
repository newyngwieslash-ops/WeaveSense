-- One lock per calendar day, shared across price versions.
create table if not exists ai_budget_admission_days(day text primary key);
