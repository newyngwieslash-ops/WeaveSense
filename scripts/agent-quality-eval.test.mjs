import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateCases, scoreQuality, parseEvalArgs, runQualityEval } from "./agent-quality-eval.mjs";

const fixture = JSON.parse(readFileSync(new URL("../validation/agent/opencode/quality-cases.json", import.meta.url), "utf8"));
test("offline fixtures cover 30 cases and all six defect classes without model quality claims", () => {
  assert.ok(fixture.cases.length >= 30);
  const result = evaluateCases(fixture.cases);
  assert.equal(result.mode, "offline_fixture_validation");
  assert.equal(result.model_quality_evaluated, false);
  assert.equal(result.model_calls, 0);
  assert.equal(result.fixture_mismatches.length, 0);
  assert.equal(result.metrics.false_negatives, 0);
  assert.equal(result.metrics.false_positives, 0);
  assert.ok(result.metrics.true_negatives >= 12);
  assert.equal(Object.keys(result.by_defect).length, 6);
});

test("scorer exposes misses, false alarms, invalid outputs and denominators", () => {
  const m = scoreQuality([
    { expected_blocked: true, blocked: false, valid: true },
    { expected_blocked: true, blocked: true, valid: true },
    { expected_blocked: false, blocked: true, valid: true },
    { expected_blocked: false, blocked: true, valid: false },
  ]);
  assert.equal(m.false_negatives, 1); assert.equal(m.true_positives, 1);
  assert.equal(m.false_positives, 2); assert.equal(m.invalid_reports, 1);
  assert.equal(m.blocking_recall, 0.5); assert.equal(m.false_block_rate, 1);
  assert.equal(scoreQuality([]).blocking_recall, null);
  assert.equal(scoreQuality([]).false_block_rate, null);
  const invalidDefect = scoreQuality([{ expected_blocked: true, blocked: true, valid: false }]);
  assert.equal(invalidDefect.blocking_recall, 0);
  assert.equal(invalidDefect.unsafe_acceptances, 0);
});

test("fixtures are schema-validated, unknown cases and false negatives cannot disappear", () => {
  const cases = structuredClone(fixture.cases);
  const bad = cases.find(c => c.expected_blocked);
  bad.reviewer.checks = bad.reviewer.checks.map(c => ({ ...c, status: "pass" }));
  bad.reviewer.findings = [];
  const result = evaluateCases(cases);
  assert.equal(result.metrics.false_negatives, 1);
  assert.equal(result.fixture_mismatches.length, 1);
  assert.throws(() => evaluateCases([{ ...cases[0], expected_blocked: "false" }]), /invalid_quality_case/);
  assert.throws(() => evaluateCases([cases[0], cases[0]]), /duplicate_quality_case/);
});

test("live is explicit and bounded; no provider adapter is silently invoked", () => {
  assert.deepEqual(parseEvalArgs([]), { mode: "offline" });
  for (const args of [["--live"], ["--live", "--max-cases=0", "--budget-cny=1"], ["--live", "--max-cases=3", "--budget-cny=NaN"], ["--live", "--max-cases=3", "--budget-cny=1=extra"], ["--live", "--offline"], ["--unknown"]]) {
    assert.throws(() => parseEvalArgs(args));
  }
  const args = ["--live", "--max-cases=3", "--budget-cny=1"];
  assert.deepEqual(parseEvalArgs(args), { mode: "live", maxCases: 3, budgetCny: 1 });
  assert.throws(() => runQualityEval(args), /live_config_required/);
  assert.deepEqual(parseEvalArgs([...args, '--config=isolated.json']), { mode: 'live', maxCases: 3, budgetCny: 1, configPath: 'isolated.json' });
  assert.equal(parseEvalArgs(['--live', '--max-cases=30', '--budget-cny=10000']).budgetCny, 10000);
  assert.throws(() => parseEvalArgs(['--live', '--max-cases=30', '--budget-cny=10001']), /live_requires_bounded_cases_and_budget/);
  assert.deepEqual(parseEvalArgs(['--score-live=observations.json', '--labels=labels.json']), { mode: 'score-live', observationsPath: 'observations.json', labelsPath: 'labels.json' });
});
