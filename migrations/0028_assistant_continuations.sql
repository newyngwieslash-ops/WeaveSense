-- 0028: optional auto-interpretation continuations (plan Task 22 / §6.4).
-- At most ONE continuation per (action, completion_version): approval
-- replays, SSE reconnects and worker crashes may all observe the same
-- terminal receipt, but only the first observer creates the internal
-- explanation turn. The continuation consumes the ROOT request's remaining
-- budget — never a second allocation — and carries no write authority.

create table assistant_continuations (
  id text primary key,
  action_id text not null references assistant_actions(id),
  root_request_id text not null,
  parent_turn_id text not null references assistant_turns(id),
  completion_version integer not null default 1 check (completion_version = 1),
  status text not null check (status in ('pending','running','succeeded','failed','skipped_no_budget','cancelled')),
  explanation text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);

-- Exactly one continuation per terminal action state.
create unique index assistant_continuation_once
  on assistant_continuations(action_id, completion_version);
create index assistant_continuation_parent_idx
  on assistant_continuations(parent_turn_id, created_at);
