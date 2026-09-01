const TRACKING_PARAMS = new Set([
  "scene", "sessionid", "clicktime", "enterid", "ascene", "devicetype", "version", "nettype",
  "lang", "exportkey", "pass_ticket", "wx_header", "chksm", "mpshare", "srcid",
  "sharer_shareinfo", "sharer_shareinfo_first", "from", "isappinstalled",
]);
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function invalid() {
  throw new Error("validation_invalid_input");
}

function timestamp(value) {
  if (typeof value !== "string") invalid();
  const match = value.match(ISO);
  if (!match) invalid();
  const [, y, m, d, h, minute, second, zone] = match;
  const parts = [y, m, d, h, minute, second].map(Number);
  const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const offset = zone === "Z" ? [0, 0] : zone.slice(1).split(":").map(Number);
  if (day.getUTCFullYear() !== parts[0] || day.getUTCMonth() !== parts[1] - 1 ||
    day.getUTCDate() !== parts[2] || parts[3] > 23 || parts[4] > 59 || parts[5] > 59 ||
    offset[0] > 23 || offset[1] > 59 || !Number.isFinite(Date.parse(value))) invalid();
  return Date.parse(value);
}

function records(value) {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) invalid();
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shanghaiDay(milliseconds) {
  return new Date(milliseconds + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

export function usageDaysForWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) invalid();
  const from = timestamp(window.from);
  const to = timestamp(window.to);
  if (from >= to) invalid();
  const first = shanghaiDay(from);
  const exactMidnight = (to + SHANGHAI_OFFSET_MS) % DAY_MS === 0;
  const exclusive = exactMidnight ? shanghaiDay(to) : nextDay(shanghaiDay(to));
  const days = [];
  for (let day = first; day < exclusive; day = nextDay(day)) days.push(day);
  if (!days.length || days.length > 31) invalid();
  return days;
}

export function normalizeReferenceUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" || url.username || url.password) throw new Error();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch {
    throw new Error("validation_invalid_url");
  }
}

function urlOf(row) {
  try { return normalizeReferenceUrl(text(row.original_url)); }
  catch { return ""; }
}

function percentage(value) {
  return value === null ? null : Math.round(value * 100_000) / 1_000;
}

function ratioMetric(raw, value, operator, threshold, available = true) {
  const pass = available && (operator === ">=" ? value >= threshold : value < threshold);
  return { raw, value: available ? value : null, percentage: available ? percentage(value) : null,
    threshold: { operator, value: threshold }, available, pass };
}

function countMetric(raw, value, threshold, available = true) {
  return { raw, value: available ? value : null, percentage: raw.total > 0 && available
    ? percentage(value / raw.total) : null, threshold: { operator: "=", value: threshold },
  available, pass: available && value === threshold };
}

function budgetMetric(raw, value, threshold, available) {
  return { raw, value: available ? value : null,
    percentage: available && threshold > 0 ? percentage(value / threshold) : null,
    threshold: { operator: "<=", value: threshold }, available,
    pass: available && value <= threshold };
}

export function evaluateWechatValidation({ reference = [], items = [], health = [], usage = null,
  limits = null, window = null, jobs = [], mode = "fixture", generatedAt = null, asOf = null } = {}) {
  reference = records(reference);
  items = records(items);
  health = records(health);
  jobs = records(jobs);
  if (!window || typeof window !== "object" || Array.isArray(window)) invalid();
  const from = timestamp(window.from);
  const to = timestamp(window.to);
  if (from >= to) invalid();
  const generated = generatedAt ?? window.to;
  timestamp(generated);
  const asOfTime = timestamp(asOf);
  if (asOfTime < to || asOfTime > to + 2 * 60 * 60 * 1000) invalid();

  const referenceCanonical = new Set();
  const referenceCanonicalUrls = new Set();
  const referenceUrlOnly = new Set();
  for (const row of reference) {
    if (!text(row.account_id) || !text(row.account_name) || !text(row.title) || !text(row.published_at)) invalid();
    const published = timestamp(row.published_at);
    if (published < from || published >= to) invalid();
    const url = normalizeReferenceUrl(text(row.original_url));
    if (typeof row.provider_known !== "boolean") invalid();
    const canonical = text(row.canonical_id);
    if (canonical) {
      if (referenceCanonical.has(canonical)) invalid();
      referenceCanonical.add(canonical);
      referenceCanonicalUrls.add(url);
    } else {
      if (referenceUrlOnly.has(url)) invalid();
      referenceUrlOnly.add(url);
    }
  }
  if ([...referenceUrlOnly].some((url) => referenceCanonicalUrls.has(url))) invalid();
  for (const row of items) {
    const collected = timestamp(row.collected_at);
    if (collected >= to) invalid();
  }
  for (const row of health) {
    if (!text(row.source_id) || !["normal", "degraded", "paid_fallback", "alert"].includes(row.alert_state)) invalid();
    for (const field of ["last_primary_ok_at", "last_paid_check_at", "last_paid_ok_at"]) {
      if (row[field] !== null && row[field] !== undefined) {
        const last = timestamp(row[field]);
        if (last > asOfTime) invalid();
      }
    }
  }

  const byCanonical = new Map();
  const urlOnlyByUrl = new Map();
  const allByUrl = new Map();
  const canonicalIds = new Set();
  const canonicalUrls = new Set();
  const urlOnlyUrls = new Set();
  let unkeyed = 0;
  const add = (index, key, entry) => {
    if (!key) return;
    const rows = index.get(key) ?? [];
    rows.push(entry);
    index.set(key, rows);
  };
  items.forEach((row, index) => {
    const canonical = text(row.canonical_id);
    const url = urlOf(row);
    const entry = { row, index, canonical, url, collected: timestamp(row.collected_at) };
    add(allByUrl, url, entry);
    if (canonical) {
      canonicalIds.add(canonical);
      if (url) canonicalUrls.add(url);
      add(byCanonical, canonical, entry);
    } else if (url) {
      urlOnlyUrls.add(url);
      add(urlOnlyByUrl, url, entry);
    } else unkeyed += 1;
  });
  const requiredValid = items.filter((row) => text(row.title) && text(row.account_name) && (() => {
    try { timestamp(row.published_at); normalizeReferenceUrl(text(row.original_url)); return true; }
    catch { return false; }
  })()).length;
  for (const index of [byCanonical, urlOnlyByUrl, allByUrl]) {
    for (const entries of index.values()) entries.sort((left, right) =>
      left.collected - right.collected || left.index - right.index);
  }
  const consumed = new Set();
  const candidateOffsets = new Map();
  const discovered = Array(reference.length);
  const referenceOrder = reference.map((_, index) => index)
    .sort((left, right) => Number(!text(reference[left].canonical_id)) -
      Number(!text(reference[right].canonical_id)) || left - right);
  const earliestUnused = (candidates) => {
    let offset = candidateOffsets.get(candidates) ?? 0;
    while (offset < candidates.length && consumed.has(candidates[offset].index)) offset += 1;
    candidateOffsets.set(candidates, offset + 1);
    return candidates[offset] ?? null;
  };
  for (const referenceIndex of referenceOrder) {
    const row = reference[referenceIndex];
    const canonical = text(row.canonical_id);
    const url = urlOf(row);
    let entry = canonical ? earliestUnused(byCanonical.get(canonical) ?? []) : null;
    if (!entry) entry = earliestUnused(canonical ? urlOnlyByUrl.get(url) ?? [] : allByUrl.get(url) ?? []);
    if (entry) consumed.add(entry.index);
    discovered[referenceIndex] = { row, item: entry?.row ?? null };
  }
  const within = discovered.filter(({ row, item }) => item &&
    timestamp(item.collected_at) - timestamp(row.published_at) >= 0 &&
    timestamp(item.collected_at) - timestamp(row.published_at) <= 2 * 60 * 60 * 1000).length;
  const providerKnown = discovered.filter(({ row }) => row.provider_known);
  const providerMissing = providerKnown.filter(({ item }) => !item).length;
  const unique = canonicalIds.size + [...urlOnlyUrls].filter((url) => !canonicalUrls.has(url)).length + unkeyed;
  const duplicates = items.length - unique;
  const body = items.filter((row) => text(row.body)).length;
  const cover = items.filter((row) => {
    try { const url = new URL(text(row.cover_url)); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  }).length;
  const overdue = health.filter((row) => row.last_primary_ok_at == null ||
    asOfTime - timestamp(row.last_primary_ok_at) >= 24 * 60 * 60 * 1000);
  const missedAlerts = overdue.filter((row) => row.alert_state !== "alert").length;

  const usageAvailable = usage && typeof usage === "object" && !Array.isArray(usage) &&
    limits && typeof limits === "object" && !Array.isArray(limits);
  if (usageAvailable && (!(Number.isSafeInteger(usage.calls) && usage.calls >= 0) ||
    !(Number.isFinite(usage.amount) && usage.amount >= 0) ||
    !Array.isArray(usage.days) ||
    !(Number.isSafeInteger(limits.daily_calls) && limits.daily_calls >= 0) ||
    !(Number.isFinite(limits.daily_rmb) && limits.daily_rmb >= 0))) invalid();
  const expectedDays = usageDaysForWindow(window);
  const daily = usageAvailable ? usage.days.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.day) ||
      !(Number.isSafeInteger(row.calls) && row.calls >= 0) ||
      !(Number.isFinite(row.amount) && row.amount >= 0)) invalid();
    return { day: row.day, calls: row.calls, amount: row.amount };
  }) : [];
  if (usageAvailable && (daily.length !== expectedDays.length ||
    daily.some((row, index) => row.day !== expectedDays[index]))) invalid();
  const calls = daily.reduce((sum, row) => sum + row.calls, 0);
  const amount = Number(daily.reduce((sum, row) => sum + row.amount, 0).toFixed(6));
  if (usageAvailable && (calls !== usage.calls || Math.abs(amount - usage.amount) > 1e-9)) invalid();
  const dailyCalls = usageAvailable ? limits.daily_calls : 0;
  const dailyRmb = usageAvailable ? limits.daily_rmb : 0;
  const callViolations = daily.filter((row) => row.calls > dailyCalls);
  const amountViolations = daily.filter((row) => row.amount > dailyRmb);
  const maxCalls = daily.reduce((maximum, row) => Math.max(maximum, row.calls), 0);
  const maxAmount = daily.reduce((maximum, row) => Math.max(maximum, row.amount), 0);

  const metrics = {
    required_fields: ratioMetric({ valid: requiredValid, total: items.length },
      items.length ? requiredValid / items.length : 0, ">=", 0.99, items.length > 0),
    discovery_within_2h: ratioMetric({ within_2h: within, total: reference.length },
      reference.length ? within / reference.length : 0, ">=", 0.95, reference.length > 0),
    provider_known_missing: countMetric({ missing: providerMissing, total: providerKnown.length },
      providerMissing, 0, providerKnown.length > 0),
    duplicate_rate: ratioMetric({ duplicate_rows: duplicates, total: items.length, unique },
      items.length ? duplicates / items.length : 0, "<", 0.001, items.length > 0),
    body_coverage: ratioMetric({ nonblank: body, total: items.length },
      items.length ? body / items.length : 0, ">=", 0.8, items.length > 0),
    cover_coverage: ratioMetric({ https_nonblank: cover, total: items.length },
      items.length ? cover / items.length : 0, ">=", 0.9, items.length > 0),
    outage_alerts: countMetric({ missed: missedAlerts, overdue: overdue.length,
      total: health.length, as_of: asOf },
      missedAlerts, 0, health.length > 0),
    paid_calls: budgetMetric({ total_calls: calls, max_daily: maxCalls, limit: dailyCalls,
      violations: callViolations, days: daily }, maxCalls, dailyCalls, Boolean(usageAvailable)),
    paid_amount: budgetMetric({ total_amount: amount, max_daily: maxAmount, limit: dailyRmb,
      violations: amountViolations, days: daily }, maxAmount, dailyRmb, Boolean(usageAvailable)),
  };
  return {
    version: "wechat-validation/v1", mode,
    window: { from: window.from, to: window.to }, generated_at: generated,
    raw: { reference_rows: reference.length, collected_rows: items.length,
      unique_collected_rows: unique, health_rows: health.length, job_rows: jobs.length },
    metrics, paid: { calls, amount, daily_calls: dailyCalls, daily_rmb: dailyRmb, days: daily },
    overall: Object.values(metrics).every((metric) => metric.available && metric.pass),
  };
}
