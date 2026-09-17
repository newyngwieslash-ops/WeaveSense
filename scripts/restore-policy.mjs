/**
 * T03: restore-safety guard rails.
 *
 * Pure functions, so the *same* rules the recovery script enforces are directly
 * testable without a database. Three ways a restore silently destroys data:
 *   - restoring into an existing database (implicty overwriting it),
 *   - accepting a corrupt archive as one that "applied fine",
 *   - operating on a resource that is not this batch's own.
 */

/** A restore target must be new; an existing database is a stop condition. */
export function assertRestoreTargetIsNew(existingDatabases, target) {
  if (existingDatabases.includes(target)) throw new Error("restore_target_exists");
}

/**
 * Only a resource carrying this batch's label may be dumped, restored or
 * removed. Anything else (a foreign container, an untagged one, a missing one)
 * is refused rather than assumed safe.
 */
export function assertTaggedResource(label, expected = "isolated") {
  if (label !== expected) throw new Error("resource_label_mismatch");
}

/**
 * A failed restore must not be reported as a success: the script's exit status
 * has to be non-zero whenever the verification summary is absent or false.
 */
export function exitStatusFor(result) {
  return result && result.ok === true ? 0 : 1;
}
