/**
 * T10: cursor arithmetic for external ids that may exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Message/video ids are decimal strings from the platform and are compared to
 * decide how far a source's cursor may advance. `Number(id)` silently rounds past
 * 2^53 (a valid telegram id rounds `…93` to `…92`), and a rounded *high* cursor
 * skips real content, while a rounded *low* cursor re-fetches it. Neither shows
 * up as an error — the same class of bug as the页码 skip this task fixes.
 *
 * These helpers keep ids as strings and compare them the one way that is always
 * correct for non-negative decimal integers: strip leading zeros, then compare
 * by length first and lexicographically second.
 */

/** True when the id is a non-empty string of ASCII digits (no sign, no spaces). */
export function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/** Normalize a numeric id for comparison: leading zeros removed, "0" kept as-is. */
function normalizeId(id: string): string {
  const trimmed = id.replace(/^0+(?=\d)/, "");
  return trimmed;
}

/**
 * Compare two non-negative decimal integer strings.
 * Returns -1, 0 or 1. Non-numeric or empty inputs are treated as "absent" and
 * sort below any real id, so a missing cursor never looks like a high one.
 */
export function compareNumericIds(a: unknown, b: unknown): -1 | 0 | 1 {
  const validA = isNumericId(a);
  const validB = isNumericId(b);
  if (!validA && !validB) return 0;
  if (!validA) return -1;
  if (!validB) return 1;
  const na = normalizeId(a);
  const nb = normalizeId(b);
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

/** The greatest numeric id among the candidates, or undefined when there is none. */
export function maxNumericId(candidates: readonly unknown[]): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (!isNumericId(candidate)) continue;
    if (best === undefined || compareNumericIds(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * Whether `candidate` may replace `current` as a persisted high-water mark.
 *
 * A cursor only ever moves forward, and only to an id that was actually
 * persisted. Equality is not an advance (it would re-write the same value).
 */
export function canAdvanceCursor(current: unknown, candidate: unknown): boolean {
  if (!isNumericId(candidate)) return false;
  if (!isNumericId(current)) return true; // no cursor yet
  return compareNumericIds(candidate, current) > 0;
}
