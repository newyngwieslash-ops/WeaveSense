-- 0026: assistant product sessions (plan §5.1).
-- Product conversations/turns/messages/events/actions + the per-run tool
-- ledger. The OpenCode runtime keeps no chat history; the host database is
-- the single source of truth. UUIDs are app-generated (existing text style).

create table assistant_conversations (
  id text primary key,
  title text not null default '',
  revision bigint not null default 0 check (revision >= 0),
  status text not null default 'open' check (status in ('open','archived')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table assistant_turns (
  id text primary key,
  conversation_id text not null references assistant_conversations(id),
  request_id text not null unique,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in (
    'queued','running','awaiting_confirmation','executing','waiting_child',
    'completed','failed','cancelled','outcome_unknown')),
  job_id text references ai_jobs(id),
  run_id text references ai_runs(id),
  context_json jsonb not null default '{}'::jsonb check (jsonb_typeof(context_json)='object'),
  policy_json jsonb not null default '{}'::jsonb check (jsonb_typeof(policy_json)='object'),
  authorization_json jsonb,
  last_seq bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique (job_id),
  unique (run_id)
);

create table assistant_messages (
  id text primary key,
  conversation_id text not null references assistant_conversations(id),
  turn_id text not null references assistant_turns(id),
  ordinal integer not null check (ordinal >= 0),
  role text not null check (role in ('user','assistant','action_result')),
  content_json jsonb not null check (jsonb_typeof(content_json)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (conversation_id, ordinal)
);

create table assistant_events (
  id text primary key,
  conversation_id text not null references assistant_conversations(id),
  turn_id text not null references assistant_turns(id),
  seq bigint not null check (seq >= 0),
  type text not null check (type in (
    'turn.queued','turn.started','tool.started','tool.completed','message.completed',
    'action.proposed','action.updated','child.updated','entity.changed','turn.finished')),
  payload_json jsonb not null check (jsonb_typeof(payload_json)='object'),
  created_at timestamptz not null default clock_timestamp()
);

create table assistant_actions (
  id text primary key,
  turn_id text not null references assistant_turns(id),
  ordinal integer not null check (ordinal between 0 and 3),
  kind text not null check (kind in (
    'keyword.create','keyword.update','keyword.set_enabled','keyword.collect_once',
    'source.create','source.set_enabled','source.collect_once',
    'research.start','research.cancel','item.analyze','knowledge.briefing')),
  args_json jsonb not null check (jsonb_typeof(args_json)='object'),
  intent_digest text not null check (intent_digest ~ '^[a-f0-9]{64}$'),
  preview_json jsonb,
  preview_digest text check (preview_digest is null or preview_digest ~ '^[a-f0-9]{64}$'),
  expected_state_json jsonb,
  authorization_source text not null default 'preview' check (authorization_source in ('preview','intent')),
  status text not null check (status in (
    'proposed','approved','executing','succeeded','failed',
    'rejected','expired','conflict','cancelled','outcome_unknown')),
  decision_request_id text,
  claim_token text,
  lease_until timestamptz,
  dispatch_started_at timestamptz,
  child_job_id text,
  result_json jsonb check (result_json is null or jsonb_typeof(result_json)='object'),
  error_code text not null default '',
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (turn_id, ordinal),
  unique (turn_id, intent_digest),
  unique (decision_request_id),
  check (expires_at is null or status in ('proposed','approved') or expires_at < created_at + interval '30 days')
);

create table assistant_tool_calls (
  run_id text not null references ai_runs(id),
  call_id text not null,
  tool text not null check (tool in (
    'project_overview','list_keywords','list_sources','search_items','get_item',
    'list_notes','get_note','list_collection_jobs','get_collection_job',
    'get_research_status','get_operation','get_service_status')),
  args_digest text not null check (args_digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('started','completed')),
  result_json jsonb check (result_json is null or jsonb_typeof(result_json)='object'),
  result_digest text check (result_digest is null or result_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  primary key (run_id, call_id)
);

-- All tables exist; now the indexes (plan §5.1 ordering).
create unique index assistant_one_active_turn
  on assistant_turns(conversation_id)
  where status in ('queued','running','awaiting_confirmation','executing','waiting_child');
create index assistant_conversation_updated_idx on assistant_conversations(updated_at desc);
create index assistant_turn_conversation_idx on assistant_turns(conversation_id, created_at);
create index assistant_message_conversation_idx on assistant_messages(conversation_id, ordinal desc);
create unique index assistant_conversation_event_seq on assistant_events(conversation_id, seq);
create unique index assistant_decision_once on assistant_actions(decision_request_id) where decision_request_id is not null;
create index assistant_action_claim on assistant_actions(status, created_at) where status = 'approved';
create index assistant_action_turn_idx on assistant_actions(turn_id, ordinal);
create index assistant_tool_calls_run_idx on assistant_tool_calls(run_id, created_at);
