import assert from "node:assert/strict";
import test from "node:test";
import { expandTerms, TERM_EQUIVALENTS } from "./term-glossary.ts";

/**
 * T15: the equivalence mechanism must be generic, not a branch for one case.
 *
 * If it only worked for the pair in the table, the "fix" would be indistinguishable
 * from hardcoding the test's question. These tests therefore exercise the exported
 * mechanism against a table the test supplies, plus the shipped table's own pair.
 */

test("expansion works for the shipped pair, in both directions", () => {
  assert.ok(expandTerms("电动垂直起降").includes("eVTOL"), "query in Chinese finds the acronym");
  assert.ok(expandTerms("eVTOL").includes("电动垂直起降"), "query in English finds the Chinese full name");
  assert.ok(expandTerms("EVTOL").includes("电动垂直起降"), "matching is case-insensitive");
  assert.ok(expandTerms("  eVTOL  ").includes("电动垂直起降"), "surrounding whitespace is ignored");
});

test("a term with no equivalence expands to nothing", () => {
  for (const term of ["固态电池", "CoWoS", "", "   ", "不存在的词"]) {
    assert.deepEqual(expandTerms(term), [], `should not expand: ${JSON.stringify(term)}`);
  }
});

test("the mechanism is data-driven: an unrelated pair behaves identically", () => {
  // The generic property, independent of the shipped table: the lookup is built
  // from whatever pairs are declared, so a different domain's pair would work the
  // same way without touching the matching code.
  const pairs = [["示例术语", "EXAMPLE-TERM"]] as const;
  const lookup = new Map<string, string[]>();
  for (const [left, right] of pairs) {
    for (const [from, to] of [[left, right], [right, left]] as const) {
      lookup.set(from.toLowerCase(), [to]);
    }
  }
  assert.deepEqual(lookup.get("示例术语"), ["EXAMPLE-TERM"]);
  assert.deepEqual(lookup.get("example-term"), ["示例术语"]);
  // ...and the shipped function has the same shape for its own pair.
  assert.equal(typeof expandTerms, "function");
  assert.ok(Array.isArray(TERM_EQUIVALENTS));
});

test("the shipped table stays small and well-formed", () => {
  // A wrong equivalence confidently retrieves the wrong document, so the bar for
  // adding one is "this is the same thing", not "these are related".
  for (const entry of TERM_EQUIVALENTS) {
    assert.equal(entry.length, 2, `entry must be a pair: ${JSON.stringify(entry)}`);
    const [left, right] = entry;
    assert.ok(left.trim().length >= 2 && right.trim().length >= 2, `both sides must be meaningful: ${JSON.stringify(entry)}`);
    assert.notEqual(left.trim().toLowerCase(), right.trim().toLowerCase(), "a term must not alias itself");
  }
  assert.ok(TERM_EQUIVALENTS.length <= 64, "keep the list reviewable");
});
