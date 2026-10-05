export const PRIMARY_FAILURE_THRESHOLD = 2;
export const PAID_RETRY_MINUTES = [5, 15, 60];

const SHANGHAI = "Asia/Shanghai";
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SHANGHAI,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(formatter, now) {
  return Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
}

function timeOf(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function nowTime(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  return now.getTime();
}

function eventTime(value, nowMs) {
  const timestamp = timeOf(value);
  return timestamp !== null && timestamp <= nowMs ? timestamp : null;
}

function hasTimeValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function shanghaiDay(now) {
  nowTime(now);
  const { year, month, day } = parts(dateFormatter, now);
  return `${year}-${month}-${day}`;
}

export function shanghaiHourMinute(now) {
  nowTime(now);
  const { hour, minute } = parts(timeFormatter, now);
  return `${hour}:${minute}`;
}

export function paidDecision(source, now) {
  const nowMs = nowTime(now);
  if (source.last_paid_result === "mapping_error") return { allowed: false, reason: "mapping_error" };

  const retryAt = timeOf(source.next_retry_at);
  if (hasTimeValue(source.next_retry_at) && retryAt === null) {
    return { allowed: false, reason: "invalid_retry_at" };
  }
  if (retryAt !== null && retryAt > nowMs) return { allowed: false, reason: "retry_backoff" };

  if ((source.consecutive_primary_failures ?? 0) >= PRIMARY_FAILURE_THRESHOLD) {
    return { allowed: true, reason: "primary_failed" };
  }

  const primaryBaseline = eventTime(source.last_primary_ok_at, nowMs) ?? eventTime(source.created_at, nowMs);
  if (primaryBaseline !== null && nowMs - primaryBaseline >= SIX_HOURS_MS) {
    return { allowed: true, reason: "primary_stale" };
  }
  return { allowed: false, reason: "primary_healthy" };
}

export function freshnessState(source, now) {
  const nowMs = nowTime(now);
  const contentAt = eventTime(source.last_primary_content_at, nowMs);
  const hours = source.expected_update_hours;
  if (contentAt === null || typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return "unknown";
  return nowMs - contentAt > 3 * hours * 3_600_000 ? "suspected_stale" : "fresh";
}

export function nextPaidRetry(now, failedAttemptCount) {
  const nowMs = nowTime(now);
  const attempt = Math.max(1, Math.trunc(Number(failedAttemptCount)) || 1);
  const minutes = PAID_RETRY_MINUTES[Math.min(attempt, PAID_RETRY_MINUTES.length) - 1];
  return new Date(nowMs + minutes * 60_000).toISOString();
}

export function shouldReconcile(source, now) {
  const nowMs = nowTime(now);
  if (shanghaiHourMinute(now) < "23:30") return false;
  if (source.last_paid_result === "mapping_error") return false;

  if (source.last_paid_result === "ok") {
    const successAt = eventTime(source.last_paid_ok_at, nowMs)
      ?? eventTime(source.last_paid_check_at, nowMs);
    return successAt === null || shanghaiDay(new Date(successAt)) !== shanghaiDay(now);
  }

  const retryAt = timeOf(source.next_retry_at);
  if (hasTimeValue(source.next_retry_at) && retryAt === null) return false;
  if (source.last_paid_result === "technical_error" && retryAt !== null && retryAt > nowMs) return false;

  const paidAt = eventTime(source.last_paid_check_at, nowMs);
  if (paidAt === null || shanghaiDay(new Date(paidAt)) !== shanghaiDay(now)) return true;
  if (source.last_paid_result !== "technical_error") return !source.last_paid_result;

  return retryAt === null || retryAt <= nowMs;
}

export function alertState(source, now) {
  const nowMs = nowTime(now);
  const primaryOk = eventTime(source.last_primary_ok_at, nowMs);
  const explicitPaidOk = eventTime(source.last_paid_ok_at, nowMs);
  const compatiblePaidOk = source.last_paid_result === "ok"
    ? eventTime(source.last_paid_check_at, nowMs)
    : null;
  const paidSuccesses = [explicitPaidOk, compatiblePaidOk].filter((value) => value !== null);
  const paidOk = paidSuccesses.length ? Math.max(...paidSuccesses) : null;
  const successes = [primaryOk, paidOk].filter((value) => value !== null);
  const latestSuccess = successes.length ? Math.max(...successes) : eventTime(source.created_at, nowMs);

  if (latestSuccess !== null && nowMs - latestSuccess >= ONE_DAY_MS) return "alert";
  if (paidOk !== null && (primaryOk === null || paidOk > primaryOk)) return "paid_fallback";

  const primaryBaseline = primaryOk ?? eventTime(source.created_at, nowMs);
  if ((source.consecutive_primary_failures ?? 0) > 0
    || (primaryBaseline !== null && nowMs - primaryBaseline >= SIX_HOURS_MS)) return "degraded";
  return "normal";
}
