import { DatabaseSync } from "node:sqlite";

// ponytail: six-decimal RMB precision; move to integer micro-RMB storage if provider billing gets finer.
const MONEY_SCALE = 1_000_000;
function money(value) {
  return Math.round(value * MONEY_SCALE) / MONEY_SCALE;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function callCap(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("dailyCallCap must be a non-negative integer");
  }
  return value;
}

function key(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function rollback(db) {
  try { db.exec("rollback"); } catch { /* preserve the transaction error */ }
}

function providersSeen(row, provider) {
  let providers = [];
  try {
    const parsed = JSON.parse(row?.providers_seen ?? "[]");
    if (Array.isArray(parsed)) providers = parsed.filter((value) => typeof value === "string" && value);
  } catch { /* repair malformed internal history on the next upsert */ }
  return JSON.stringify([...new Set([...providers, row?.provider, provider].filter(Boolean))]);
}

function preferNonEmpty(incoming, existing = "") {
  const value = String(incoming ?? "");
  return value.trim() ? value : existing;
}

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec("pragma busy_timeout = 5000");
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
    last_paid_ok_at text,
    last_paid_result text not null default '',
    next_retry_at text,
    alert_state text not null default 'normal',
    created_at text not null,
    updated_at text not null
  )`);
  const sourceColumns = db.prepare("pragma table_info(gateway_sources)").all();
  if (!sourceColumns.some(({ name }) => name === "last_paid_ok_at")) {
    db.exec("alter table gateway_sources add column last_paid_ok_at text");
  }
  db.exec(`update gateway_sources set last_paid_ok_at = last_paid_check_at
    where last_paid_ok_at is null and last_paid_result = 'ok'`);
  db.exec(`create table if not exists provider_usage (
    day text not null,
    provider text not null,
    calls integer not null default 0 check (calls >= 0),
    amount real not null default 0 check (amount >= 0),
    updated_at text not null,
    primary key (day, provider)
  );
  create table if not exists gateway_items (
    source_id text not null,
    canonical_id text not null,
    account_id text not null,
    account_name text not null,
    title text not null,
    published_at text not null,
    original_url text not null,
    body_text text not null default '',
    cover_url text not null default '',
    provider text not null,
    providers_seen text not null default '[]',
    discovered_at text not null,
    updated_at text not null,
    primary key (source_id, canonical_id)
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
  const paidResult = db.prepare(`update gateway_sources set
    last_paid_check_at = ?,
    last_paid_ok_at = case when ? = 'ok' then ? else last_paid_ok_at end,
    last_paid_result = ?, next_retry_at = ?, alert_state = ?, updated_at = ?
    where source_id = ?`);
  const getUsage = db.prepare("select calls, amount from provider_usage where day = ? and provider = ?");
  const reserveUsage = db.prepare(`insert into provider_usage (day, provider, calls, amount, updated_at)
    values (?, ?, 1, ?, ?)
    on conflict(day, provider) do update set
      calls = provider_usage.calls + 1, amount = ?, updated_at = ?`);
  const adjustUsage = db.prepare(`update provider_usage set amount = ?, updated_at = ?
    where day = ? and provider = ?`);
  const getItem = db.prepare(`select provider, providers_seen, body_text, cover_url
    from gateway_items where source_id = ? and canonical_id = ?`);
  const upsertItem = db.prepare(`insert into gateway_items
    (source_id, canonical_id, account_id, account_name, title, published_at, original_url,
      body_text, cover_url, provider, providers_seen, discovered_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_id, canonical_id) do update set
      account_id=excluded.account_id, account_name=excluded.account_name, title=excluded.title,
      published_at=excluded.published_at, original_url=excluded.original_url,
      body_text=excluded.body_text, cover_url=excluded.cover_url, provider=excluded.provider,
      providers_seen=excluded.providers_seen, discovered_at=excluded.discovered_at,
      updated_at=excluded.updated_at`);
  const listItems = db.prepare(`select * from gateway_items
    where source_id = ? and unixepoch(published_at) >= unixepoch(?)
    order by unixepoch(published_at) desc, canonical_id`);
  const deleteItems = db.prepare("delete from gateway_items where unixepoch(published_at) < unixepoch(?)");

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
    recordPaidResult(sourceId, result, nextRetryAt, alertState, now = new Date().toISOString()) {
      paidResult.run(now, result, now, result, nextRetryAt, alertState, now, sourceId);
    },
    tryReserveSpend(day, provider, estimate, dailyRmbCap, dailyCallCap) {
      day = key(day, "day");
      provider = key(provider, "provider");
      estimate = money(nonNegativeNumber(estimate, "estimate"));
      dailyRmbCap = money(nonNegativeNumber(dailyRmbCap, "dailyRmbCap"));
      dailyCallCap = callCap(dailyCallCap);
      db.exec("begin immediate");
      try {
        const current = getUsage.get(day, provider) ?? { calls: 0, amount: 0 };
        const nextAmount = money(Number(current.amount) + estimate);
        if (nextAmount > dailyRmbCap || Number(current.calls) + 1 > dailyCallCap) {
          db.exec("rollback");
          return false;
        }
        const now = new Date().toISOString();
        reserveUsage.run(day, provider, nextAmount, now, nextAmount, now);
        db.exec("commit");
        return true;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    adjustSpend(day, provider, estimate, actual) {
      day = key(day, "day");
      provider = key(provider, "provider");
      estimate = money(nonNegativeNumber(estimate, "estimate"));
      actual = money(Math.max(0, finiteNumber(actual, "actual")));
      db.exec("begin immediate");
      try {
        const current = getUsage.get(day, provider);
        if (!current) throw new Error("provider spend reservation not found");
        const amount = money(Math.max(0, Number(current.amount) - estimate + actual));
        adjustUsage.run(amount, new Date().toISOString(), day, provider);
        db.exec("commit");
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    getProviderUsage(day, provider) {
      const usage = getUsage.get(key(day, "day"), key(provider, "provider"));
      return usage ? { calls: Number(usage.calls), amount: money(Number(usage.amount)) }
        : { calls: 0, amount: 0 };
    },
    getProviderBudgetState(day, provider, dailyRmbCap, dailyCallCap) {
      dailyRmbCap = money(nonNegativeNumber(dailyRmbCap, "dailyRmbCap"));
      dailyCallCap = callCap(dailyCallCap);
      const { calls, amount } = this.getProviderUsage(day, provider);
      if (amount >= dailyRmbCap || calls >= dailyCallCap) return "budget_exhausted";
      if (amount >= money(dailyRmbCap * 0.8) || calls >= dailyCallCap * 0.8) return "warning";
      return "normal";
    },
    upsertGatewayItems(sourceId, items, now = new Date().toISOString()) {
      sourceId = key(sourceId, "sourceId");
      if (!Array.isArray(items)) throw new TypeError("items must be an array");
      db.exec("begin immediate");
      try {
        for (const item of items) {
          const canonicalId = key(item.canonical_id, "canonical_id");
          const provider = key(item.provider, "provider");
          const existing = getItem.get(sourceId, canonicalId);
          upsertItem.run(sourceId, canonicalId, item.account_id, item.account_name, item.title,
            item.published_at, item.original_url,
            preferNonEmpty(item.body_text, existing?.body_text),
            preferNonEmpty(item.cover_url, existing?.cover_url), provider,
            providersSeen(existing, provider), item.discovered_at, now);
        }
        db.exec("commit");
        return items.length;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    listGatewayItems(sourceId, sinceIso) {
      return listItems.all(key(sourceId, "sourceId"), key(sinceIso, "sinceIso"));
    },
    deleteGatewayItemsBefore(cutoffIso) {
      return Number(deleteItems.run(key(cutoffIso, "cutoffIso")).changes);
    },
    close() { db.close(); },
  };
}
