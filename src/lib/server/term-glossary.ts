/**
 * T15: term equivalences for retrieval.
 *
 * The gap this closes is a *lexical* one, and it is common in this product's
 * domain: a user types the Chinese full name of a technology while the collected
 * material uses its English acronym (「电动垂直起降」 vs `eVTOL`). Character
 * n-grams cannot bridge that — no amount of slicing 电动垂直起降 yields `eVTOL` —
 * so the relationship has to be stated somewhere.
 *
 * It is stated here as **data**, not as a branch in the retrieval code:
 *   - the list is a plain array, so an operator can extend it for their own
 *     domain without touching matching logic;
 *   - `expandTerms` is generic: it expands whatever pairs it is given, and a test
 *     proves that with an unrelated pair (see term-glossary.test.ts), so the
 *     mechanism does not depend on any particular entry;
 *   - matching stays lexical. This is deliberately NOT a vector search: the plan
 *     requires evidence before adding that, and one alias pair is not evidence.
 *
 * Entries are matched case-insensitively and bidirectionally (query may use
 * either side). Keep the list small and factual — a wrong equivalence produces
 * confident wrong retrievals, which is worse than a miss.
 */
export const TERM_EQUIVALENTS: readonly (readonly [string, string])[] = [
  // 低空经济 / eVTOL — the corpus and questions use both forms.
  ["电动垂直起降", "eVTOL"],
] as const;

/** Case-folded lookup built once from the table above. */
const LOOKUP: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [left, right] of TERM_EQUIVALENTS) {
    for (const [from, to] of [[left, right], [right, left]] as const) {
      const key = from.trim().toLowerCase();
      if (!key) continue;
      const existing = map.get(key) ?? [];
      const value = to.trim();
      if (value && !existing.includes(value)) existing.push(value);
      map.set(key, existing);
    }
  }
  return map;
})();

/**
 * Equivalent forms of one term, or an empty array when it has none.
 * Returns the *other* side only: the caller already has the original term.
 */
export function expandTerms(term: string): string[] {
  if (!term) return [];
  return [...(LOOKUP.get(term.trim().toLowerCase()) ?? [])];
}
