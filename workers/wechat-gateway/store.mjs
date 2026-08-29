import { DatabaseSync } from "node:sqlite";

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists gateway_sources (
    source_id text primary key,
    account_id text not null,
    name text not null,
    priority text not null default 'normal' check (priority in ('normal', 'high')),
    sample_url text not null,
    primary_feed_url text not null,
    last_primary_ok_at text,
    consecutive_primary_failures integer not null default 0,
    last_paid_check_at text,
    last_paid_result text not null default '',
    next_retry_at text,
    alert_state text not null default 'normal',
    created_at text not null,
    updated_at text not null
  )`);

  const upsert = db.prepare(`insert into gateway_sources
    (source_id, account_id, name, priority, sample_url, primary_feed_url, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_id) do update set
      account_id=excluded.account_id, name=excluded.name, priority=excluded.priority,
      sample_url=excluded.sample_url, primary_feed_url=excluded.primary_feed_url,
      updated_at=excluded.updated_at`);
  const get = db.prepare("select * from gateway_sources where source_id = ?");
  const list = db.prepare("select * from gateway_sources order by source_id");
  const success = db.prepare(`update gateway_sources set
    last_primary_ok_at = ?, consecutive_primary_failures = 0, updated_at = ?
    where source_id = ?`);
  const failure = db.prepare(`update gateway_sources set
    consecutive_primary_failures = consecutive_primary_failures + 1, updated_at = ?
    where source_id = ?`);

  return {
    upsertSource(source, now = new Date().toISOString()) {
      upsert.run(source.id, source.account_id, source.name, source.priority, source.sample_url,
        source.primary_feed_url, now, now);
      return get.get(source.id);
    },
    getSource(sourceId) { return get.get(sourceId); },
    listSources() { return list.all(); },
    recordPrimarySuccess(sourceId, now = new Date().toISOString()) {
      success.run(now, now, sourceId);
    },
    recordPrimaryFailure(sourceId, now = new Date().toISOString()) {
      failure.run(now, sourceId);
    },
  };
}
