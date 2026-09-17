import assert from "node:assert/strict";
import test from "node:test";
import { canAdvanceCursor, compareNumericIds, isNumericId, maxNumericId } from "./cursor.ts";

/**
 * T10: cursor comparison must survive ids beyond 2^53.
 *
 * `Number("9007199254740993") >= Number("9007199254740992")` is `true`, so the
 * old `Number(...)` reduce could pick a *wrong* maximum — and picking the wrong
 * maximum skips content or re-fetches it, silently, with no error to notice.
 */

test("ids beyond 2^53 compare exactly", () => {
  // These two differ by 1 but `Number()` maps both to 9007199254740992.
  assert.equal(compareNumericIds("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareNumericIds("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareNumericIds("9007199254740993", "9007199254740993"), 0);
  // The old approach, for contrast: this is why string comparison is needed.
  assert.equal(Number("9007199254740993") >= Number("9007199254740992"), true);
  assert.equal(Number("9007199254740993") === Number("9007199254740992"), true, "both round to the same double");
});

test("ordinary ids compare numerically, not lexicographically", () => {
  // "9" > "10" as text; numerically 9 < 10.
  assert.equal(compareNumericIds("9", "10"), -1);
  assert.equal(compareNumericIds("100", "99"), 1);
  assert.equal(compareNumericIds("0007", "7"), 0, "leading zeros must not change the value");
  assert.equal(compareNumericIds("1000", "999"), 1);
});

test("a missing cursor never looks like a high one", () => {
  assert.equal(compareNumericIds(undefined, "5"), -1);
  assert.equal(compareNumericIds("5", undefined), 1);
  assert.equal(compareNumericIds(undefined, undefined), 0);
  assert.equal(compareNumericIds("", "5"), -1);
  assert.equal(compareNumericIds("abc", "5"), -1, "a non-numeric id is not a cursor");
});

test("the maximum picks the exact greatest id", () => {
  assert.equal(maxNumericId(["9007199254740992", "9007199254740993"]), "9007199254740993");
  assert.equal(maxNumericId(["9", "10", "100"]), "100");
  assert.equal(maxNumericId([]), undefined);
  assert.equal(maxNumericId(["abc", ""]), undefined);
  assert.equal(maxNumericId(["abc", "12"]), "12");
});

test("the cursor only moves forward, and only to a persisted id", () => {
  assert.equal(canAdvanceCursor("100", "101"), true);
  assert.equal(canAdvanceCursor("100", "100"), false, "equality is not an advance");
  assert.equal(canAdvanceCursor("100", "99"), false, "a cursor never goes backwards");
  assert.equal(canAdvanceCursor("", "1"), true, "no cursor yet");
  assert.equal(canAdvanceCursor("100", undefined), false);
  assert.equal(canAdvanceCursor("100", "not-a-number"), false);
  assert.equal(canAdvanceCursor("9007199254740992", "9007199254740993"), true);
});

test("numeric id detection rejects anything that is not a plain decimal", () => {
  assert.equal(isNumericId("123"), true);
  assert.equal(isNumericId("0"), true);
  for (const value of ["-1", "1.5", " 1", "1e3", "0x10", "", undefined, null, 123, {}]) {
    assert.equal(isNumericId(value), false, `should reject: ${String(value)}`);
  }
});
