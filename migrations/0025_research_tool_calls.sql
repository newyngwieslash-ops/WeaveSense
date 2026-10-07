-- One budget fact per corpus RPC, regardless of how many evidence rows it returns.
create table ai_tool_calls (
  run_id text not null references ai_runs(id),
  call_id text not null,
  tool text not null check(tool in ('search_items','get_item')),
  request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
  state text not null check(state in ('started','completed')),
  result_json jsonb,
  result_digest text check(result_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  primary key(run_id,call_id)
);
