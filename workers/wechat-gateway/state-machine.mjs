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

export function shanghaiDay(now) {
  const { year, month, day } = parts(dateFormatter, now);
  return `${year}-${month}-${day}`;
}

export function shanghaiHourMinute(now) {
  const { hour, minute } = parts(timeFormatter, now);
  return `${hour}:${minute}`;
}

export function paidDecision(source, now) {
  const nowMs = now.getTime();
  const retryAt = timeOf(source.next_retry_at);
  if (retryAt !== null && retryAt > nowMs) return { allowed: false, reason: "retry_backoff" };

  if ((source.consecutive_primary_failures ?? 0) >= PRIMARY_FAILURE_THRESHOLD) {
    return { allowed: true, reason: "primary_failed" };
  }

  const primaryBaseline = timeOf(source.last_primary_ok_at) ?? timeOf(source.created_at);
  if (primaryBaseline !== null && nowMs - primaryBaseline >= SIX_HOURS_MS) {
    return { allowed: true, reason: "primary_stale" };
  }
  return { allowed: false, reason: "primary_healthy" };
}

export function nextPaidRetry(now, failedAttemptCount) {
  const attempt = Math.max(1, Math.trunc(Number(failedAttemptCount)) || 1);
  const minutes = PAID_RETRY_MINUTES[Math.min(attempt, PAID_RETRY_MINUTES.length) - 1];
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export function shouldReconcile(source, now) {
  if (shanghaiHourMinute(now) < "23:30") return false;

  const paidAt = timeOf(source.last_paid_check_at);
  if (paidAt === null || shanghaiDay(new Date(paidAt)) !== shanghaiDay(now)) return true;
  if (source.last_paid_result !== "technical_error") return !source.last_paid_result;

  const retryAt = timeOf(source.next_retry_at);
  return retryAt === null || retryAt <= now.getTime();
}

export function alertState(source, now) {
  const nowMs = now.getTime();
  const primaryOk = timeOf(source.last_primary_ok_at);
  const paidOk = source.last_paid_result === "ok" ? timeOf(source.last_paid_check_at) : null;
  const successes = [primaryOk, paidOk].filter((value) => value !== null);
  const latestSuccess = successes.length ? Math.max(...successes) : timeOf(source.created_at);

  if (latestSuccess !== null && nowMs - latestSuccess >= ONE_DAY_MS) return "alert";
  if (paidOk !== null && (primaryOk === null || paidOk > primaryOk)) return "paid_fallback";

  const primaryBaseline = primaryOk ?? timeOf(source.created_at);
  if ((source.consecutive_primary_failures ?? 0) > 0
    || (primaryBaseline !== null && nowMs - primaryBaseline >= SIX_HOURS_MS)) return "degraded";
  return "normal";
}
