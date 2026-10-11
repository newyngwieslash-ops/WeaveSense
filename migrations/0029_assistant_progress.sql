-- Assistant live progress (plan §5.4 extension): the worker's message poll
-- publishes tool stages + the reasoning tail as assistant.progress events so
-- the panel can render the run like the opencode TUI (snapshot granularity,
-- not per-token). Worker rate-limits and caps payloads before posting.
alter table assistant_events drop constraint assistant_events_type_check;
alter table assistant_events add constraint assistant_events_type_check check (type in (
  'turn.queued','turn.started','tool.started','tool.completed','message.completed',
  'action.proposed','action.updated','child.updated','entity.changed','turn.finished',
  'assistant.progress'));
