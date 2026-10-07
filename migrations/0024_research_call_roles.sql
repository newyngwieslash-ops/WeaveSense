alter table ai_model_calls add column role text not null default 'producer' check (role in ('producer','reviewer'));
alter table ai_model_calls add column request_digest text check (request_digest is null or request_digest ~ '^[a-f0-9]{64}$');
create index ai_model_calls_role_idx on ai_model_calls(run_id,role);
