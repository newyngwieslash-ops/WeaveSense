import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { agentResultSchema } from "../src/lib/agent-contract.ts";
import { reviewDigests, validateReviewReport } from "../src/lib/server/agent-review.ts";
import { runLiveQuality, scoreLiveFiles } from "./agent-quality-live.mjs";

const defects = ["reverse_support", "source_independence", "date_scope", "conflict_omission", "truncated_coverage", "unsupported_certainty"];
const caseSchema = z.object({
  id: z.string().min(1), defect: z.enum(defects), question: z.string().min(1),
  expected_blocked: z.boolean(), rationale: z.string().min(1),
  candidate: agentResultSchema,
  evidence: z.array(z.object({ evidence_id: z.string().min(1), text: z.string(), origin: z.literal("internal"), item_id: z.string() }).passthrough()).min(1),
  reviewer: z.record(z.string(), z.unknown()),
}).strict();

export function scoreQuality(rows) {
  const checked = z.array(z.object({ expected_blocked: z.boolean(), blocked: z.boolean(), valid: z.boolean() }).passthrough()).parse(rows);
  const count = predicate => checked.filter(predicate).length;
  const defective = count(row => row.expected_blocked);
  const normal = checked.length - defective;
  const truePositives = count(row => row.expected_blocked && row.valid && row.blocked);
  const falsePositives = count(row => !row.expected_blocked && (!row.valid || row.blocked));
  return {
    total: checked.length, defective, normal,
    true_positives: truePositives,
    false_negatives: defective - truePositives,
    false_positives: falsePositives,
    true_negatives: normal - falsePositives,
    invalid_reports: count(row => !row.valid),
    blocking_recall: defective ? truePositives / defective : null,
    false_block_rate: normal ? falsePositives / normal : null,
    unsafe_acceptances: count(row => row.expected_blocked && row.valid && !row.blocked),
  };
}

export function evaluateCases(cases) {
  const parsed = z.array(caseSchema).safeParse(cases);
  if (!parsed.success || parsed.data.length === 0) throw new Error("invalid_quality_case");
  if (new Set(parsed.data.map(c => c.id)).size !== parsed.data.length) throw new Error("duplicate_quality_case");
  const rows = parsed.data.map((c, index) => {
    const context = {
      run_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      candidate: c.candidate, evidence: c.evidence,
      policy: { version: "quality-fixtures-v1", question: c.question },
    };
    const raw = JSON.stringify({ schema_version: 1, run_id: context.run_id, ...reviewDigests(c.candidate, c.evidence, context.policy), ...c.reviewer });
    const result = validateReviewReport(raw, context);
    return { id: c.id, defect: c.defect, expected_blocked: c.expected_blocked, valid: result.ok, blocked: result.ok ? result.blocked : true, error: result.ok ? null : result.error };
  });
  return {
    mode: "offline_fixture_validation", model_quality_evaluated: false, model_calls: 0,
    limitation: "Authored reviewer fixtures validate only report contracts and scoring. These are not model observations or evidence of quality gain.",
    metrics: scoreQuality(rows),
    by_defect: Object.fromEntries(defects.map(defect => [defect, scoreQuality(rows.filter(row => row.defect === defect))])),
    fixture_mismatches: rows.filter(row => !row.valid || row.blocked !== row.expected_blocked).map(row => row.id),
    results: rows,
  };
}

export function parseEvalArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--offline")) return { mode: "offline" };
  if (args.some(arg => arg.startsWith("--score-live="))) {
    if (args.length !== 2 || !args.some(arg => /^--labels=.+$/.test(arg)) || args.filter(arg => /^--score-live=.+$/.test(arg)).length !== 1) throw new Error("invalid_eval_arguments");
    return { mode: "score-live", observationsPath: args.find(arg => arg.startsWith("--score-live=")).slice(13), labelsPath: args.find(arg => arg.startsWith("--labels=")).slice(9) };
  }
  if (!args.includes("--live") || ![3, 4].includes(args.length) || args.filter(arg => arg === "--live").length !== 1 ||
      args.some(arg => !/^--(?:live|max-cases=\d+|budget-cny=\d+(?:\.\d+)?|config=.+)$/.test(arg))) throw new Error("invalid_eval_arguments");
  const cases = args.find(arg => /^--max-cases=\d+$/.test(arg));
  const budget = args.find(arg => /^--budget-cny=\d+(?:\.\d+)?$/.test(arg));
  const maxCases = Number(cases?.split("=")[1]);
  const budgetCny = Number(budget?.split("=")[1]);
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 100 || !Number.isFinite(budgetCny) || budgetCny <= 0 || budgetCny > 10000) throw new Error("live_requires_bounded_cases_and_budget");
  const configs = args.filter(arg => arg.startsWith("--config="));
  if ((args.length === 4 && configs.length !== 1) || (args.length === 3 && configs.length)) throw new Error("invalid_eval_arguments");
  return { mode: "live", maxCases, budgetCny, ...(configs.length ? { configPath: configs[0].slice(9) } : {}) };
}

export function runQualityEval(args) {
  const options = parseEvalArgs(args);
  if (options.mode === "score-live") return scoreLiveFiles(options.observationsPath, options.labelsPath);
  if (options.mode === "live") {
    if (!options.configPath) throw new Error("live_config_required");
    return runLiveQuality(options);
  }
  const fixture = JSON.parse(readFileSync(new URL("../validation/agent/opencode/quality-cases.json", import.meta.url), "utf8"));
  return evaluateCases(fixture.cases);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runQualityEval(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.fixture_mismatches?.length || (result.mode === "live_blind_scoring" && !(result.opencode_evaluated ? result.live_accepted : result.reviewer_accepted))) process.exitCode = 1;
  } catch (error) {
    // A live transport failure can follow a committed send; never print zero spend.
    console.error(JSON.stringify({ error: error.message, ...(process.argv.includes("--live") ? { model_calls: null, outcome: "inspect_saved_observations_and_ledger" } : { model_calls: 0 }) }));
    process.exitCode = 1;
  }
}
