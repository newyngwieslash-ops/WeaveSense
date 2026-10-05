import { DatabaseSync } from "node:sqlite";

// ponytail: six-decimal RMB precision; move to integer micro-RMB storage if provider billing gets finer.
const MONEY_SCALE = 1_000_000;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const PAID_RESULTS = new Set(["ok", "technical_error", "mapping_error"]);
const ALERT_STATES = new Set(["normal", "degraded", "paid_fallback", "alert"]);
const WECHAT_HOSTS = new Set(["mp.weixin.qq.com"]);
const COVER_HOSTS = new Set(["mmbiz.qpic.cn", "mmbiz.qlogo.cn"]);

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function money(value, name = "amount") {
  nonNegativeNumber(value, name);
  const scaled = Math.round(value * MONEY_SCALE);
  if (!Number.isSafeInteger(scaled)) throw new TypeError(`${name} is too large`);
  return scaled / MONEY_SCALE;
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

function iso(value, name, nullable = false) {
  if (nullable && value == null) return null;
  const raw = key(value, name);
  const match = ISO_TIMESTAMP.exec(raw);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , offsetHourText = "0", offsetMinuteText = "0"] = match ?? [];
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [yearText, monthText, dayText, hourText, minuteText, secondText,
      offsetHourText, offsetMinuteText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!match || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
    || !Number.isFinite(Date.parse(raw))) {
    throw new TypeError(`${name} must be a valid ISO timestamp`);
  }
  return raw;
}

function reservationId(value) {
  const raw = typeof value === "bigint" ? String(value)
    : typeof value === "number" && Number.isSafeInteger(value) ? String(value)
      : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(raw)) throw new TypeError("reservationId is invalid");
  return raw;
}

function hasExplicitPort(raw) {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  return /:\d*$/.test(authority.slice(authority.lastIndexOf("@") + 1));
}

function httpsUrl(value, name, allowedHosts, optional = false) {
  if (optional && (value == null || String(value).trim() === "")) return "";
  const raw = key(value, name);
  let url;
  try { url = new URL(raw); } catch { throw new TypeError(`${name} must be a safe HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || hasExplicitPort(raw) || !allowedHosts.has(url.hostname)) {
    throw new TypeError(`${name} must be a safe HTTPS URL`);
  }
  return raw;
}

function rollback(db) {
  try { db.exec("rollback"); } catch { /* preserve the transaction error */ }
}

// T13: `unknown` is a first-class outcome. A request that was sent but whose
// result never arrived may have been charged, so its conservative reservation
// stays on the books instead of being settled at the estimate (which would erase
// money that was probably spent) or released to zero (which would do the same and
// also free budget for another call).
const RESERVATIONS_SQL = `create table provider_reservations (
  id integer primary key autoincrement,
  day text not null,
  provider text not null,
  estimate real not null check (estimate >= 0),
  actual real check (actual is null or actual >= 0),
  status text not null default 'open' check (status in ('open', 'settled', 'overrun', 'unknown')),
  reason text not null default '',
  created_at text not null,
  settled_at text
)`;

function migrateReservations(db) {
  const schema = db.prepare("select sql from sqlite_master where type = 'table' and name = 'provider_reservations'")
    .get()?.sql;
  if (!schema) {
    db.exec(RESERVATIONS_SQL);
  } else {
    const columns = db.prepare("pragma table_info(provider_reservations)").all();
    const needsActual = !columns.some(({ name }) => name === "actual");
    const needsOverrun = !schema.includes("'overrun'");
    // T13 additions: the `unknown` outcome and its reason.
    const needsUnknown = !schema.includes("'unknown'");
    const needsReason = !columns.some(({ name }) => name === "reason");
    if (needsActual || needsOverrun || needsUnknown || needsReason) {
      // Rebuild with the current shape. Historical rows are carried over
      // verbatim: an old 'settled' row keeps its amount and status, and no
      // historical cost is rewritten to 0.
      db.exec(`drop index if exists provider_reservations_open;
        alter table provider_reservations rename to provider_reservations_legacy;
        ${RESERVATIONS_SQL};
        insert into provider_reservations
          (id, day, provider, estimate, actual, status, reason, created_at, settled_at)
          select id, day, provider, estimate,
                 ${needsActual ? "null" : "actual"},
                 status,
                 ${needsReason ? "''" : "reason"},
                 created_at, settled_at
          from provider_reservations_legacy;
        drop table provider_reservations_legacy`);
    }
  }
  db.exec(`create index if not exists provider_reservations_open
    on provider_reservations(day, provider, status, id)`);
}

function initialize(db) {
  db.exec("begin immediate");
  try {
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
    for (const [column, type] of [["last_primary_content_at", "text"], ["latest_published_at", "text"],
      ["expected_update_hours", "real check (expected_update_hours > 0)"],
      ["last_primary_error_type", "text not null default ''"]]) {
      if (!sourceColumns.some(({ name }) => name === column)) {
        db.exec(`alter table gateway_sources add column ${column} ${type}`);
      }
    }
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
      body_complete integer not null default 0,
      cover_url text not null default '',
      provider text not null,
      providers_seen text not null default '[]',
      discovered_at text not null,
      updated_at text not null,
      primary key (source_id, canonical_id)
    );
    create table if not exists reconciliation_outbox (
      source_id text primary key,
      created_at text not null
    );
    create table if not exists primary_content_evidence (
      source_id text not null,
      canonical_id text not null,
      body_present integer not null default 0,
      body_complete integer not null default 0,
      primary key (source_id, canonical_id)
    );
    create table if not exists detail_queue (
      source_id text not null,
      canonical_id text not null,
      item_json text not null,
      attempts integer not null default 0,
      next_retry_at text,
      last_error text not null default '',
      created_at text not null,
      updated_at text not null,
      primary key (source_id, canonical_id)
    )`);
    const itemColumns = db.prepare("pragma table_info(gateway_items)").all();
    if (!itemColumns.some(({ name }) => name === "body_complete")) {
      db.exec("alter table gateway_items add column body_complete integer not null default 0");
    }
    const evidenceColumns = db.prepare("pragma table_info(primary_content_evidence)").all();
    if (!evidenceColumns.some(({ name }) => name === "body_known")) {
      db.exec("alter table primary_content_evidence add column body_known integer not null default 1 check (body_known in (0, 1))");
    }
    // Preserve retained identities before global pruning or a paid merge can erase their evidence.
    const seedEvidence = db.prepare(`insert into primary_content_evidence
      (source_id, canonical_id, body_present, body_complete, body_known) values (?, ?, ?, ?, ?)`);
    for (const row of db.prepare(`select i.* from gateway_items i left join primary_content_evidence e
      on e.source_id = i.source_id and e.canonical_id = i.canonical_id where e.canonical_id is null`).all()) {
      const seen = JSON.parse(providersSeen(row, ""));
      if (!seen.includes("primary")) continue;
      // Mixed history proves identity only; its merged body may have come from paid completion.
      const known = Number(seen.length === 1);
      const present = Number(Boolean(known && row.body_text.trim()));
      seedEvidence.run(row.source_id, row.canonical_id, present,
        Number(Boolean(present && row.body_complete)), known);
    }
    migrateReservations(db);
    db.exec("commit");
  } catch (error) {
    rollback(db);
    throw error;
  }
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

function mergedBody(existing, incoming) {
  const existingComplete = Boolean(existing?.body_complete);
  const incomingComplete = Boolean(incoming.body_complete);
  return {
    text: existingComplete ? existing.body_text
      : incomingComplete ? preferNonEmpty(incoming.body_text, existing?.body_text)
        : preferNonEmpty(existing?.body_text, incoming.body_text),
    complete: Number(existingComplete || incomingComplete),
  };
}

function validateGatewayItem(item) {
  if (!item || typeof item !== "object") throw new TypeError("item is required");
  const valid = { ...item };
  for (const field of ["canonical_id", "account_id", "account_name", "title", "provider"]) {
    valid[field] = key(item[field], field);
  }
  valid.published_at = iso(item.published_at, "published_at");
  valid.discovered_at = iso(item.discovered_at, "discovered_at");
  valid.original_url = httpsUrl(item.original_url, "original_url", WECHAT_HOSTS);
  valid.cover_url = httpsUrl(item.cover_url, "cover_url", COVER_HOSTS, true);
  valid.body_text = String(item.body_text ?? "");
  if (item.body_complete !== undefined && typeof item.body_complete !== "boolean") {
    throw new TypeError("body_complete must be boolean");
  }
  valid.body_complete = item.body_complete === true;
  return valid;
}

function createStore(db) {
  const upsert = db.prepare(`insert into gateway_sources
    (source_id, account_id, name, priority, sample_url, primary_feed_url, expected_update_hours, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_id) do update set
      name=excluded.name, priority=excluded.priority,
      sample_url=excluded.sample_url, primary_feed_url=excluded.primary_feed_url,
      expected_update_hours=excluded.expected_update_hours,
      updated_at=excluded.updated_at`);
  const resetMapping = db.prepare(`update gateway_sources set
    last_paid_check_at = null, last_paid_result = '', next_retry_at = null,
    alert_state = 'normal', updated_at = ? where source_id = ?`);
  const get = db.prepare("select * from gateway_sources where source_id = ?");
  const list = db.prepare("select * from gateway_sources order by source_id");
  const success = db.prepare(`update gateway_sources set
    last_primary_ok_at = ?, consecutive_primary_failures = 0, last_primary_error_type = '', updated_at = ?
    where source_id = ?`);
  const failure = db.prepare(`update gateway_sources set
    consecutive_primary_failures = consecutive_primary_failures + 1, last_primary_error_type = ?, updated_at = ?
    where source_id = ?`);
  // ponytail: one compact row per primary canonical ID, unbounded history; archive per source only if exact dedupe is preserved.
  const getEvidence = db.prepare("select * from primary_content_evidence where source_id = ? and canonical_id = ?");
  const putEvidence = db.prepare(`insert into primary_content_evidence
    (source_id, canonical_id, body_present, body_complete, body_known) values (?, ?, ?, ?, 1)
    on conflict(source_id, canonical_id) do update set
      body_present = max(body_present, excluded.body_present),
      body_complete = max(body_complete, excluded.body_complete), body_known = 1`);
  const contentTime = db.prepare(`update gateway_sources set last_primary_content_at = ?, updated_at = ?
    where source_id = ? and (last_primary_content_at is null or julianday(last_primary_content_at) < julianday(?))`);
  const publicationTime = db.prepare(`update gateway_sources set latest_published_at = ?
    where source_id = ? and (latest_published_at is null or julianday(latest_published_at) < julianday(?))`);
  const paidResult = db.prepare(`update gateway_sources set
    last_paid_check_at = ?,
    last_paid_ok_at = case when ? = 'ok' then ? else last_paid_ok_at end,
    last_paid_result = ?, next_retry_at = ?, alert_state = ?, updated_at = ?
    where source_id = ?`);
  const addOutbox = db.prepare(`insert into reconciliation_outbox (source_id, created_at)
    values (?, ?) on conflict(source_id) do nothing`);
  const listOutbox = db.prepare(`select source_id from reconciliation_outbox
    order by created_at, source_id limit 500`);
  const ackOutbox = db.prepare("delete from reconciliation_outbox where source_id = ?");
  const getUsage = db.prepare("select calls, amount from provider_usage where day = ? and provider = ?");
  const listUsage = db.prepare(`select day, calls, amount from provider_usage
    where day >= ? and day < ? and provider = ? order by day limit 32`);
  const reserveUsage = db.prepare(`insert into provider_usage (day, provider, calls, amount, updated_at)
    values (?, ?, 1, ?, ?)
    on conflict(day, provider) do update set
      calls = provider_usage.calls + 1, amount = ?, updated_at = ?`);
  const adjustUsage = db.prepare(`update provider_usage set amount = ?, updated_at = ?
    where day = ? and provider = ?`);
  const addReservation = db.prepare(`insert into provider_reservations
    (day, provider, estimate, status, created_at) values (?, ?, ?, 'open', ?)`);
  const getReservation = db.prepare(`select id, day, provider, estimate, actual, status, reason
    from provider_reservations where id = ?`);
  const settleReservation = db.prepare(`update provider_reservations
    set status = ?, actual = ?, reason = ?, settled_at = ? where id = ? and status = 'open'`);
  const lastReservation = db.prepare("select id from provider_reservations order by id desc limit 1");
  const listOverrunRows = db.prepare(`select id, day, provider, estimate, actual, reason, settled_at
    from provider_reservations
    where day = ? and provider = ? and status = 'overrun'
    order by id`);
  const getItem = db.prepare(`select account_id, provider, providers_seen, body_text, body_complete, cover_url
    from gateway_items where source_id = ? and canonical_id = ?`);
  const upsertItem = db.prepare(`insert into gateway_items
    (source_id, canonical_id, account_id, account_name, title, published_at, original_url,
      body_text, body_complete, cover_url, provider, providers_seen, discovered_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_id, canonical_id) do update set
      account_name=excluded.account_name, title=excluded.title,
      published_at=excluded.published_at, original_url=excluded.original_url,
      body_text=excluded.body_text, body_complete=excluded.body_complete,
      cover_url=excluded.cover_url, provider=excluded.provider,
      providers_seen=excluded.providers_seen, discovered_at=excluded.discovered_at,
      updated_at=excluded.updated_at`);
  const listItems = db.prepare(`select *, (select last_primary_content_at from gateway_sources
    where source_id=gateway_items.source_id) as primary_content_at from gateway_items
    where source_id = ? and unixepoch(published_at) >= unixepoch(?)
    order by unixepoch(published_at) desc, canonical_id`);
  const deleteItems = db.prepare("delete from gateway_items where unixepoch(published_at) < unixepoch(?)");
  const queueDetail = db.prepare(`insert into detail_queue
    (source_id, canonical_id, item_json, attempts, next_retry_at, last_error, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_id, canonical_id) do update set
      item_json=excluded.item_json,
      attempts=detail_queue.attempts + excluded.attempts,
      next_retry_at=excluded.next_retry_at,
      last_error=excluded.last_error,
      updated_at=excluded.updated_at`);
  const listDetails = db.prepare(`select * from detail_queue
    where next_retry_at is null or unixepoch(next_retry_at) <= unixepoch(?)
    order by updated_at, source_id, canonical_id limit ?`);
  const deleteDetail = db.prepare("delete from detail_queue where source_id = ? and canonical_id = ?");
  const getDetail = db.prepare("select * from detail_queue where source_id = ? and canonical_id = ?");
  const countDetails = db.prepare("select count(*) as count from detail_queue");

  function providerUsage(day, provider) {
    const usage = getUsage.get(key(day, "day"), key(provider, "provider"));
    return usage ? { calls: Number(usage.calls), amount: money(Number(usage.amount)) }
      : { calls: 0, amount: 0 };
  }

  function recordContentEvidence(sourceId, item, now) {
    // Publication is observed across both providers, independent of primary progress.
    publicationTime.run(item.published_at, sourceId, item.published_at);
    if (item.provider !== "primary") return;
    const previous = getEvidence.get(sourceId, item.canonical_id);
    const present = Number(Boolean(item.body_text.trim()));
    const complete = Number(Boolean(present && item.body_complete));
    // Unknown legacy mixed-body summaries establish a baseline, not a historical change time.
    if (!previous || (previous.body_known && !previous.body_present && present)
      || (!previous.body_complete && complete)) {
      contentTime.run(now, now, sourceId, now);
    }
    putEvidence.run(sourceId, item.canonical_id,
      Math.max(previous?.body_present ?? 0, present), Math.max(previous?.body_complete ?? 0, complete));
  }

  return {
    upsertSource(source, now = new Date().toISOString()) {
      now = iso(now, "now");
      const expectedHours = source.expected_update_hours ?? null;
      if (expectedHours !== null && !(nonNegativeNumber(expectedHours, "expected_update_hours") > 0)) {
        throw new TypeError("expected_update_hours must be positive");
      }
      db.exec("begin immediate");
      try {
        const existing = get.get(source.id);
        if (existing && existing.account_id !== source.account_id) {
          throw new Error("account_id cannot change");
        }
        upsert.run(source.id, source.account_id, source.name, source.priority, source.sample_url,
          source.primary_feed_url, source.expected_update_hours === undefined
            ? existing?.expected_update_hours ?? null : expectedHours, now, now);
        if (existing?.last_paid_result === "mapping_error"
          && existing.sample_url !== source.sample_url) resetMapping.run(now, source.id);
        const saved = get.get(source.id);
        db.exec("commit");
        return saved;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    getSource(sourceId) { return get.get(sourceId); },
    listSources() { return list.all(); },
    recordPrimarySuccess(sourceId, now = new Date().toISOString()) {
      success.run(now, now, sourceId);
    },
    recordPrimaryFailure(sourceId, now = new Date().toISOString(), errorType = "primary_feed_failed") {
      if (!["primary_feed_failed", "risk_control"].includes(errorType)) throw new TypeError("errorType is invalid");
      failure.run(errorType, now, sourceId);
    },
    recordPaidResult(sourceId, result, nextRetryAt, alertState, now = new Date().toISOString(), successAt = now,
      enqueueOutbox = false) {
      sourceId = key(sourceId, "sourceId");
      if (!PAID_RESULTS.has(result)) throw new TypeError("result is invalid");
      if (!ALERT_STATES.has(alertState)) throw new TypeError("alertState is invalid");
      now = iso(now, "now");
      successAt = iso(successAt, "successAt");
      nextRetryAt = iso(nextRetryAt, "nextRetryAt", true);
      const current = Date.parse(now);
      const incomingSuccess = Date.parse(successAt);
      if (result === "ok" && incomingSuccess > current) {
        throw new TypeError("successAt cannot be later than now");
      }
      db.exec("begin immediate");
      try {
        const source = get.get(sourceId);
        if (!source) throw new Error("source not found");
        const previous = Date.parse(source.last_paid_check_at ?? "");
        const previousSuccess = Date.parse(source.last_paid_ok_at ?? "");
        const effectiveSuccessAt = result === "ok" && Number.isFinite(previousSuccess)
          && previousSuccess >= incomingSuccess ? source.last_paid_ok_at : successAt;
        if (Number.isFinite(previous) && current <= previous) {
          if (current < previous) throw new Error("paid result is older than the stored check");
          if (source.last_paid_result !== result || source.next_retry_at !== nextRetryAt
            || source.alert_state !== alertState
            || (result === "ok" && source.last_paid_ok_at !== effectiveSuccessAt)) {
            throw new Error("paid result timestamp conflict");
          }
          if (result === "ok" && enqueueOutbox) addOutbox.run(sourceId, now);
          db.exec("commit");
          return source;
        }
        if (Number(paidResult.run(now, result, effectiveSuccessAt, result, nextRetryAt,
          alertState, now, sourceId).changes) !== 1) throw new Error("source not found");
        if (result === "ok" && enqueueOutbox) addOutbox.run(sourceId, now);
        const saved = get.get(sourceId);
        db.exec("commit");
        return saved;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    tryReserveSpend(day, provider, estimate, dailyRmbCap, dailyCallCap) {
      day = key(day, "day");
      provider = key(provider, "provider");
      // T13: without a real, verified price bound a paid call cannot reserve
      // honestly. Defaulting to a guessed number is exactly how a daily cap gets
      // exceeded, so an absent estimate refuses admission instead.
      if (estimate == null || estimate === "") return false;
      estimate = money(estimate, "estimate");
      if (!(estimate > 0)) return false;
      dailyRmbCap = money(dailyRmbCap, "dailyRmbCap");
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
        const reservation = addReservation.run(day, provider, estimate, now).lastInsertRowid;
        reserveUsage.run(day, provider, nextAmount, now, nextAmount, now);
        db.exec("commit");
        return String(reservation);
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    adjustSpend(id, actual) {
      id = reservationId(id);
      actual = money(Math.max(0, finiteNumber(actual, "actual")), "actual");
      db.exec("begin immediate");
      try {
        const reservation = getReservation.get(id);
        if (!reservation) throw new Error("provider spend reservation not found");
        if (reservation.status !== "open") {
          if (reservation.actual != null && money(Number(reservation.actual)) === actual) {
            db.exec("commit");
            return reservation.status;
          }
          // T13: a reservation closed as `unknown` may not be reopened to a lower
          // amount. The conservative figure is the record of money that may have
          // been spent; lowering it would free budget that was never freed.
          if (reservation.status === "unknown") {
            throw new Error("provider spend reservation settled unknown; not replayable");
          }
          throw new Error("provider spend reservation replay conflict");
        }
        const current = getUsage.get(reservation.day, reservation.provider);
        if (!current) throw new Error("provider usage not found");
        const now = new Date().toISOString();
        const amount = money(Math.max(0, Number(current.amount) - Number(reservation.estimate) + actual));
        const status = actual > Number(reservation.estimate) ? "overrun" : "settled";
        const reason = status === "overrun" ? "cost_above_estimate" : "";
        if (Number(settleReservation.run(status, actual, reason, now, id).changes) !== 1) {
          throw new Error("provider spend reservation was already settled");
        }
        adjustUsage.run(amount, now, reservation.day, reservation.provider);
        db.exec("commit");
        return status;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    /**
     * T13: close a reservation whose outcome never arrived.
     *
     * The conservative estimate stays on the books: the provider may well have
     * charged it, and releasing it would both hide the possible spend and free
     * budget for another call. The status is `unknown` (distinct from `settled`
     * and `overrun`) so an operator can see the uncertainty.
     */
    settleUnknown(id, { reason = "outcome_unknown" } = {}) {
      id = reservationId(id);
      db.exec("begin immediate");
      try {
        const reservation = getReservation.get(id);
        if (!reservation) throw new Error("provider spend reservation not found");
        if (reservation.status === "unknown") {
          db.exec("commit");
          return "unknown";
        }
        if (reservation.status !== "open") throw new Error("provider spend reservation replay conflict");
        const now = new Date().toISOString();
        const estimate = Number(reservation.estimate);
        if (Number(settleReservation.run("unknown", estimate, key(reason, "reason"), now, id).changes) !== 1) {
          throw new Error("provider spend reservation was already settled");
        }
        db.exec("commit");
        return "unknown";
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    /** Reservations whose real cost exceeded the estimate, for operator review. */
    listOverruns(day, provider) {
      day = key(day, "day");
      provider = key(provider, "provider");
      return listOverrunRows.all(day, provider).map((row) => ({
        id: String(row.id),
        day: String(row.day),
        provider: String(row.provider),
        estimate: money(Number(row.estimate)),
        actual: money(Number(row.actual)),
        excess: money(Math.max(0, Number(row.actual) - Number(row.estimate))),
        settled_at: String(row.settled_at ?? ""),
      }));
    },
    /** The id of the most recent reservation (test/ops convenience). */
    lastReservationId() {
      const row = lastReservation.get();
      return row ? String(row.id) : null;
    },
    getProviderUsage: providerUsage,
    listProviderUsage(fromDay, toDay, provider) {
      fromDay = key(fromDay, "fromDay");
      toDay = key(toDay, "toDay");
      provider = key(provider, "provider");
      return listUsage.all(fromDay, toDay, provider).map((row) => ({
        day: String(row.day), calls: Number(row.calls), amount: money(Number(row.amount)),
      }));
    },
    getProviderBudgetState(day, provider, dailyRmbCap, dailyCallCap) {
      dailyRmbCap = money(dailyRmbCap, "dailyRmbCap");
      dailyCallCap = callCap(dailyCallCap);
      const { calls, amount } = providerUsage(day, provider);
      if (amount >= dailyRmbCap || calls >= dailyCallCap) return "budget_exhausted";
      if (amount >= money(dailyRmbCap * 0.8) || calls >= dailyCallCap * 0.8) return "warning";
      return "normal";
    },
    upsertGatewayItems(sourceId, items, now = new Date().toISOString()) {
      sourceId = key(sourceId, "sourceId");
      if (!Array.isArray(items)) throw new TypeError("items must be an array");
      const validItems = items.map(validateGatewayItem);
      now = iso(now, "now");
      db.exec("begin immediate");
      try {
        const source = get.get(sourceId);
        if (!source) throw new Error("source not found");
        const owners = new Map();
        for (const item of validItems) {
          if (item.account_id !== source.account_id) throw new Error("account_id does not match source");
          const existing = getItem.get(sourceId, item.canonical_id);
          const owner = owners.get(item.canonical_id) ?? existing?.account_id;
          if (owner && owner !== item.account_id) throw new Error("account_id cannot change");
          owners.set(item.canonical_id, item.account_id);
        }
        for (const item of validItems) {
          const existing = getItem.get(sourceId, item.canonical_id);
          const body = mergedBody(existing, item);
          recordContentEvidence(sourceId, item, now);
          upsertItem.run(sourceId, item.canonical_id, item.account_id, item.account_name, item.title,
            item.published_at, item.original_url, body.text, body.complete,
            preferNonEmpty(item.cover_url, existing?.cover_url), item.provider,
            providersSeen(existing, item.provider), item.discovered_at, now);
        }
        db.exec("commit");
        return validItems.length;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    listGatewayItems(sourceId, sinceIso) {
      return listItems.all(key(sourceId, "sourceId"), iso(sinceIso, "sinceIso"));
    },
    getGatewayItem(sourceId, canonicalId) {
      return getItem.get(key(sourceId, "sourceId"), key(canonicalId, "canonicalId"));
    },
    listReconciliationOutbox() { return listOutbox.all().map(({ source_id }) => source_id); },
    ackReconciliationOutbox(sourceIds) {
      if (!Array.isArray(sourceIds)) throw new TypeError("sourceIds must be an array");
      db.exec("begin immediate");
      try {
        let acked = 0;
        for (const sourceId of sourceIds) acked += Number(ackOutbox.run(key(sourceId, "sourceId")).changes);
        db.exec("commit");
        return acked;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    enqueueDetail(sourceId, item, now = new Date().toISOString(), error = "", nextRetryAt = null) {
      sourceId = key(sourceId, "sourceId");
      const valid = validateGatewayItem(item);
      now = iso(now, "now");
      nextRetryAt = iso(nextRetryAt, "nextRetryAt", true);
      queueDetail.run(sourceId, valid.canonical_id, JSON.stringify(valid), error ? 1 : 0,
        nextRetryAt, String(error).slice(0, 200), now, now);
    },
    listDueDetails(now = new Date().toISOString(), limit = 2) {
      now = iso(now, "now");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError("limit is invalid");
      return listDetails.all(now, limit).map((row) => ({ ...row, item: JSON.parse(row.item_json) }));
    },
    completeDetail(sourceId, canonicalId, item, now = new Date().toISOString()) {
      sourceId = key(sourceId, "sourceId");
      canonicalId = key(canonicalId, "canonicalId");
      const valid = validateGatewayItem(item);
      now = iso(now, "now");
      db.exec("begin immediate");
      try {
        const source = get.get(sourceId);
        if (!source || valid.account_id !== source.account_id || valid.canonical_id !== canonicalId) {
          throw new Error("detail does not match source");
        }
        const existing = getItem.get(sourceId, canonicalId);
        const body = mergedBody(existing, valid);
        recordContentEvidence(sourceId, valid, now);
        upsertItem.run(sourceId, canonicalId, valid.account_id, valid.account_name, valid.title,
          valid.published_at, valid.original_url, body.text, body.complete,
          preferNonEmpty(valid.cover_url, existing?.cover_url), valid.provider,
          providersSeen(existing, valid.provider), valid.discovered_at, now);
        deleteDetail.run(sourceId, canonicalId);
        addOutbox.run(sourceId, now);
        db.exec("commit");
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    pendingDetailCount() { return Number(countDetails.get().count); },
    getPendingDetail(sourceId, canonicalId) {
      return getDetail.get(key(sourceId, "sourceId"), key(canonicalId, "canonicalId"));
    },
    removePendingDetail(sourceId, canonicalId) {
      return Number(deleteDetail.run(key(sourceId, "sourceId"), key(canonicalId, "canonicalId")).changes);
    },
    deleteGatewayItemsBefore(cutoffIso) {
      return Number(deleteItems.run(iso(cutoffIso, "cutoffIso")).changes);
    },
    close() { db.close(); },
  };
}

export function openStore(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma busy_timeout = 5000");
    initialize(db);
    return createStore(db);
  } catch (error) {
    try { db.close(); } catch { /* preserve the initialization error */ }
    throw error;
  }
}
