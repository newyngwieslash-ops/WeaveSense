import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashCanonical } from '../src/lib/server/agent-runs.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(128);
const groups = ['A', 'B', 'C'];
export const LIVE_GATES = Object.freeze({ version: 'quality-policy-v1', minimum_questions: 30, minimum_repetitions: 2,
  hard_error_publications: 0, blocking_recall: 0.9, false_block_rate: 0.1,
  b_relative_defect_reduction: 0.3, b_normal_acceptance_drop: 0.05, b_cost_ratio: 1.5,
  c_completion_gain: 0.1, c_cost_ratio: 1.3 });

const serviceURL = z.string().url().refine(raw => {
  const url = new URL(raw);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
export const liveConfigSchema = z.object({
  schema_version: z.literal(1), experiment_id: z.uuid(), arms: z.union([z.tuple([z.literal('A'), z.literal('B')]), z.tuple([z.literal('A'), z.literal('B'), z.literal('C')])]).default(['A', 'B', 'C']),
  holdout_file: z.string().min(1), holdout_sha256: digest,
  database_file: z.string().min(1), schema: z.string().regex(/^oc_live_[a-z0-9_]{8,60}$/),
  model_profile: z.object({ model: name, model_revision: name, input_per_million: z.number().positive(),
    output_per_million: z.number().positive(), price_version: name }).strict(),
  skill_snapshot_digest: digest, repetitions: z.number().int().min(1).max(3),
  execution_timeout_ms: z.number().int().min(10000).max(900000), queue_ttl_ms: z.number().int().min(1000).max(60000),
  services: z.object({ app_url: serviceURL, eino_ready_url: serviceURL }).strict(),
  containers: z.object({ database: name, app: name, eino: name, opencode_worker: name.optional(), bridge: name.optional(), runtime: name.optional() }).strict(),
  isolation_evidence_file: z.string().min(1).optional(), isolation_evidence_sha256: digest.optional(),
  isolation_host: z.object({ docker_id: name, docker_version: name, platform: name, verified_at: z.string().datetime() }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.arms.includes('C') && (!c.containers.opencode_worker || !c.containers.bridge || !c.containers.runtime || !c.isolation_evidence_file || !c.isolation_evidence_sha256 || !c.isolation_host)) ctx.addIssue({ code: 'custom', message: 'opencode_preflight_configuration_required' });
});
const holdoutSchema = z.object({ schema_version: z.literal(1), cases: z.array(z.object({
  id: name, question: z.string().min(2).max(400), source_ids: z.array(name).min(1).max(8),
}).strict()).min(1).max(100) }).strict();

function readBoundedJson(path, maxBytes = 4 * 1024 * 1024) {
  if (statSync(path).size > maxBytes) throw new Error('eval_file_too_large');
  const raw = readFileSync(path);
  return { value: JSON.parse(raw.toString('utf8')), sha256: createHash('sha256').update(raw).digest('hex') };
}
export function loadLiveConfig(configPath) {
  const base = dirname(resolve(configPath));
  const config = liveConfigSchema.parse(readBoundedJson(resolve(configPath)).value);
  if (config.model_profile.model !== config.model_profile.model_revision) throw new Error('explicit_model_revision_required');
  for (const key of ['holdout_file', 'database_file', 'isolation_evidence_file']) if (config[key]) config[key] = resolve(base, config[key]);
  const holdout = readBoundedJson(config.holdout_file);
  if (holdout.sha256 !== config.holdout_sha256) throw new Error('holdout_digest_mismatch');
  const cases = holdoutSchema.parse(holdout.value).cases;
  if (new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => new Set(c.source_ids).size !== c.source_ids.length)) throw new Error('duplicate_holdout_id');
  if (!config.arms.includes('C')) return { config, cases, isolation: null };
  const isolation = readBoundedJson(config.isolation_evidence_file);
  if (isolation.sha256 !== config.isolation_evidence_sha256 || isolation.value.network_isolation_verified !== true ||
    isolation.value.positive_host_control?.status !== 200 || !isolation.value.production_artifact?.test_fixtures_absent) throw new Error('isolation_evidence_missing');
  return { config, cases, isolation: isolation.value };
}

export function livePlan(config, cases, maxCases) {
  const selected = cases.slice(0, maxCases);
  const arms = config.arms ?? groups;
  const plan = [];
  for (let repeat = 0; repeat < config.repetitions; repeat++) for (let index = 0; index < selected.length; index++) {
    for (const comparison of ['same_producer_budget', 'equal_total_budget']) for (let offset = 0; offset < arms.length; offset++) {
      const group = arms[(index + repeat + offset) % arms.length], review = group !== 'A';
      const producer = review && comparison === 'equal_total_budget' ? 5 : 6;
      const reviewer = review ? 1 : 0, total = producer + reviewer;
      const worst = total * (512 * 1024 * config.model_profile.input_per_million + 1800 * config.model_profile.output_per_million) / 1_000_000;
      plan.push({ blind_id: randomUUID(), request_id: randomUUID(), case_id: selected[index].id,
        question: selected[index].question, source_ids: selected[index].source_ids, repeat, comparison, group,
        provider: group === 'C' ? 'opencode' : 'eino', review_mode: review ? 'enforce' : 'off',
        role_limits: { producer, reviewer }, total_model_calls: total, worst_cost_cny: worst });
    }
  }
  return plan;
}

function publishJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export async function executeLive(config, cases, options, adapter, artifactDirectory) {
  const plan = livePlan(config, cases, options.maxCases);
  const maximum = plan.reduce((sum, task) => sum + task.worst_cost_cny, 0);
  // Admission covers the entire preregistered paired experiment, not just a cheap first arm.
  if (!Number.isFinite(maximum) || maximum > options.budgetCny) throw new Error('budget_insufficient_for_paired_plan');
  const prepared = await adapter.prepare(config, cases.slice(0, options.maxCases));
  if (!prepared?.trusted_ledger || !prepared?.corpus_digest || ((config.arms ?? groups).includes('C') && !prepared?.isolation_verified)) throw new Error('live_preflight_failed');
  const manifest = { schema_version: 1, experiment_id: config.experiment_id, gates: LIVE_GATES,
    arms: config.arms ?? groups,
    requested_model_revision: config.model_profile.model_revision, model_profile: config.model_profile,
    skill_snapshot_digest: config.skill_snapshot_digest, holdout_sha256: config.holdout_sha256,
    corpus_digest: prepared.corpus_digest, preflight: prepared, execution_timeout_ms: config.execution_timeout_ms,
    queue_ttl_ms: config.queue_ttl_ms, budget_cny: options.budgetCny, worst_reserved_cny: maximum,
    conditions: { same_producer_budget: 'A=6+0 calls; B/C=6+1. Reviewer reserves a shorter Producer time window.',
      equal_total_budget: 'A=6+0 calls; B/C=5+1, identical 6-call worst-cost caps. Role allocations and Producer windows differ.' },
    plan };
  manifest.experiment_digest = hashCanonical(manifest);
  mkdirSync(artifactDirectory, { recursive: true });
  publishJson(join(artifactDirectory, 'preregistered.json'), manifest);
  const results = []; let halted = false, spent = 0;
  for (const task of plan) {
    if (halted || spent + task.worst_cost_cny > options.budgetCny) {
      results.push({ ...task, status: 'not_sent', error_code: halted ? 'experiment_halted' : 'budget_exhausted',
        actual_cost_cny: 0, model_calls: [], candidate: null });
      continue;
    }
    let observed;
    try {
      observed = await adapter.execute(task, config, prepared);
      if (!observed || !Array.isArray(observed.model_calls) || observed.model_calls.some(c => !c || typeof c.state !== 'string') || !Object.hasOwn(observed, 'candidate')) throw new Error('invalid_live_observation');
    }
    catch { observed = { status: 'outcome_unknown', error_code: 'adapter_outcome_unknown', actual_cost_cny: null, model_calls: [], candidate: null }; }
    const row = { ...observed, ...task };
    // Identity and role caps never come from the adapter or a model response.
    Object.assign(row, { blind_id: task.blind_id, case_id: task.case_id, group: task.group, comparison: task.comparison, repeat: task.repeat });
    const knownCost = typeof row.actual_cost_cny === 'number' && Number.isFinite(row.actual_cost_cny) && row.actual_cost_cny >= 0;
    if (!knownCost || row.status === 'outcome_unknown' || row.model_calls.some(c => c.state !== 'completed')) {
      halted = true; row.actual_cost_cny = null; spent += task.worst_cost_cny;
    } else {
      spent += row.actual_cost_cny;
      if (row.actual_cost_cny > task.worst_cost_cny || spent > options.budgetCny) { halted = true; row.error_code = 'observed_budget_bound_violation'; }
    }
    if (row.condition_verified !== true && row.status !== 'not_sent') { halted = true; row.error_code ||= 'frozen_condition_mismatch'; }
    results.push(row);
    publishJson(join(artifactDirectory, `observation-${String(results.length).padStart(4, '0')}.json`), row);
  }
  const result = { schema_version: 1, mode: prepared.model_source === 'real_configured_service_chain' ? 'live_observations' : 'live_driver_fake_validation', model_quality_evaluated: false,
    live_accepted: false, decision: 'pending_independent_blind_labels', manifest, results,
    budget: { limit_cny: options.budgetCny, known_actual_cny: results.reduce((n, r) => n + (r.actual_cost_cny ?? 0), 0),
      unknown_reserved_cny: results.filter(r => r.actual_cost_cny === null).reduce((n, r) => n + r.worst_cost_cny, 0) },
    halted, limitation: 'Actual runtime and ledger observations require separate independent human annotation. Authored fixtures and model self-scores are not labels.' };
  publishJson(join(artifactDirectory, 'observations.json'), result);
  // No group, runtime, ledger, Reviewer verdict, authored expectation or answer key in rater input.
  publishJson(join(artifactDirectory, 'blind-candidates.json'), { schema_version: 1, experiment_digest: manifest.experiment_digest,
    candidates: results.map(r => ({ blind_id: r.blind_id, question: r.question,
      candidate_digest: hashCanonical(r.candidate), candidate: r.candidate, evidence: r.evidence })) });
  publishJson(join(artifactDirectory, 'blind-review-findings.json'), { schema_version: 1, experiment_digest: manifest.experiment_digest,
    reviews: results.map(r => ({ blind_id: r.blind_id, candidate_digest: hashCanonical(r.candidate), findings: r.report?.findings ?? [] })) });
  return result;
}

export async function runLiveQuality(options) {
  const { config, cases, isolation } = loadLiveConfig(options.configPath);
  if (livePlan(config, cases, options.maxCases).reduce((sum, task) => sum + task.worst_cost_cny, 0) > options.budgetCny) throw new Error('budget_insufficient_for_paired_plan');
  const output = resolve('.repo', 'agent-quality-live', config.experiment_id);
  const { createLiveAdapter } = await import('../validation/agent/opencode/live-eval-adapter.mjs');
  const adapter = await createLiveAdapter({ ...config, experiment_budget_cny: options.budgetCny }, isolation);
  try { return await executeLive(config, cases, options, adapter, output); }
  finally { await adapter.close(); }
}

const labelSchema = z.object({ schema_version: z.literal(1), experiment_digest: digest,
  blinded: z.literal(true), independent: z.literal(true), annotations: z.array(z.object({
    blind_id: z.uuid(), candidate_digest: digest, grader_id: name,
    defective: z.boolean(), hard_error: z.boolean(), task_accepted: z.boolean(), evidence_support: z.boolean(),
    conflict_handling: z.boolean(), defect_localized: z.boolean().nullable(),
    defect_class: z.enum(['reverse_support', 'source_independence', 'date_scope', 'conflict_omission', 'truncated_coverage', 'unsupported_certainty', 'normal']),
  }).strict()) }).strict();
const rate = (n, d) => d ? n / d : null;
function uncertainty(n, d) {
  if (!d) return null;
  const p = n / d, z = 1.96, denominator = 1 + z * z / d;
  const center = (p + z * z / (2 * d)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d)) / denominator;
  return { numerator: n, denominator: d, estimate: p, wilson_95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
}
function groupMetrics(rows) {
  const labeled = rows.filter(r => r.label), defective = labeled.filter(r => r.label.defective), normal = labeled.filter(r => !r.label.defective);
  const accepted = rows.filter(r => r.status === 'succeeded' && r.label?.task_accepted).length;
  const completed = rows.filter(r => r.status === 'succeeded').length;
  const tp = defective.filter(r => r.review_valid && r.review_blocked).length;
  const fp = normal.filter(r => r.status !== 'succeeded').length;
  const defectsPublished = defective.filter(r => r.status === 'succeeded').length;
  const normalAccepted = normal.filter(r => r.status === 'succeeded' && r.label.task_accepted).length;
  const knownCosts = rows.filter(r => r.actual_cost_cny !== null), cost = knownCosts.reduce((n, r) => n + r.actual_cost_cny, 0);
  const recovery = rows.filter(r => r.recovery_attempted === true);
  return { total: rows.length, labeled: labeled.length, defective: defective.length, normal: normal.length,
    completed, completion_rate: rate(completed, rows.length), accepted, accepted_task_rate: rate(accepted, rows.length),
    defective_publications: defectsPublished, defective_publication_rate: rate(defectsPublished, defective.length),
    hard_error_publications: labeled.filter(r => r.status === 'succeeded' && r.label.hard_error).length,
    true_positives: tp, false_negatives: defective.length - tp, false_positives: fp,
    blocking_recall: uncertainty(tp, defective.length), false_block_rate: uncertainty(fp, normal.length),
    normal_acceptance_rate: rate(normalAccepted, normal.length),
    evidence_support: uncertainty(labeled.filter(r => r.label.evidence_support).length, labeled.length),
    conflict_handling: uncertainty(labeled.filter(r => r.label.conflict_handling).length, labeled.length),
    defect_localization: { annotated_defect_classes: Object.fromEntries(['reverse_support', 'source_independence', 'date_scope', 'conflict_omission', 'truncated_coverage', 'unsupported_certainty'].map(c => [c, defective.filter(r => r.label.defect_class === c).length])),
      accuracy: uncertainty(defective.filter(r => r.label.defect_localized === true).length, defective.filter(r => r.label.defect_localized !== null).length) },
    revision_new_errors: { measured: false, reason: 'This fixed-candidate experiment performs no revision.' },
    not_checked: rows.reduce((n, r) => n + (r.report?.checks?.filter(c => c.status === 'not_checked').length ?? 0), 0),
    actual_cost_cny: cost, unknown_costs: rows.length - knownCosts.length,
    cost_per_accepted: knownCosts.length === rows.length && accepted ? cost / accepted : null,
    producer_calls: rows.reduce((n, r) => n + r.model_calls.filter(c => c.role === 'producer').length, 0),
    reviewer_calls: rows.reduce((n, r) => n + r.model_calls.filter(c => c.role === 'reviewer').length, 0),
    tokens: Object.fromEntries(['producer', 'reviewer'].map(role => [role, {
      input: rows.reduce((n, r) => n + r.model_calls.filter(c => c.role === role).reduce((s, c) => s + Number(c.input_tokens ?? 0), 0), 0),
      output: rows.reduce((n, r) => n + r.model_calls.filter(c => c.role === role).reduce((s, c) => s + Number(c.output_tokens ?? 0), 0), 0),
      unknown: rows.flatMap(r => r.model_calls).filter(c => c.role === role && (c.input_tokens === null || c.output_tokens === null)).length,
    }])), latency_ms: { p50: percentile(rows.map(r => r.latency_ms), .5), p95: percentile(rows.map(r => r.latency_ms), .95) },
    recovery: { attempts: recovery.length, successes: recovery.filter(r => r.recovery_succeeded).length,
      rate: rate(recovery.filter(r => r.recovery_succeeded).length, recovery.length) } };
}

export function scoreLiveObservations(observations, labelInput) {
  const labels = labelSchema.parse(labelInput), { manifest, results } = observations;
  const frozen = { ...manifest }; delete frozen.experiment_digest;
  if (hashCanonical(frozen) !== manifest.experiment_digest || labels.experiment_digest !== manifest.experiment_digest ||
    hashCanonical(manifest.gates) !== hashCanonical(LIVE_GATES)) throw new Error('experiment_binding_mismatch');
  if (results.length !== manifest.plan.length || new Set(results.map(r => r.blind_id)).size !== results.length) throw new Error('missing_or_duplicate_observation');
  const planned = new Map(manifest.plan.map(row => [row.blind_id, row]));
  if (results.some(row => !planned.has(row.blind_id) || Object.keys(planned.get(row.blind_id)).some(key => hashCanonical(row[key]) !== hashCanonical(planned.get(row.blind_id)[key])))) throw new Error('observation_plan_mismatch');
  const byId = new Map(results.map(r => [r.blind_id, r])), annotations = new Map();
  for (const a of labels.annotations) {
    const row = byId.get(a.blind_id);
    if (!row || hashCanonical(row.candidate) !== a.candidate_digest) throw new Error('annotation_binding_mismatch');
    const existing = annotations.get(a.blind_id) ?? [];
    if (existing.some(v => v.grader_id === a.grader_id)) throw new Error('duplicate_grader');
    existing.push(a); annotations.set(a.blind_id, existing);
  }
  let disagreements = 0, missing = 0;
  const rows = results.map(row => {
    const votes = annotations.get(row.blind_id) ?? [];
    const facts = v => { const f = { ...v }; delete f.grader_id; return f; };
    const agrees = votes.length >= 2 && votes.every(v => hashCanonical(facts(v)) === hashCanonical(facts(votes[0])));
    if (votes.length >= 2 && !agrees) disagreements++;
    if (votes.length < 2) missing++;
    return { ...row, label: agrees ? votes[0] : null };
  });
  const comparisons = {};
  for (const comparison of ['same_producer_budget', 'equal_total_budget']) {
    const metrics = Object.fromEntries(groups.map(group => [group, groupMetrics(rows.filter(r => r.comparison === comparison && r.group === group))]));
    const { A, B, C } = metrics;
    const safety = m => m.hard_error_publications === 0 && m.blocking_recall?.estimate >= LIVE_GATES.blocking_recall &&
      m.false_block_rate?.estimate <= LIVE_GATES.false_block_rate && m.unknown_costs === 0 && m.labeled === m.total;
    const reduction = A.defective_publication_rate > 0 ? 1 - B.defective_publication_rate / A.defective_publication_rate : null;
    const bRatio = A.cost_per_accepted > 0 && B.cost_per_accepted !== null ? B.cost_per_accepted / A.cost_per_accepted : null;
    const cRatio = B.cost_per_accepted > 0 && C.cost_per_accepted !== null ? C.cost_per_accepted / B.cost_per_accepted : null;
    comparisons[comparison] = { metrics, b_relative_defect_reduction: reduction, b_cost_ratio: bRatio, c_cost_ratio: cRatio,
      b_accepted: safety(B) && reduction !== null && reduction >= LIVE_GATES.b_relative_defect_reduction &&
        A.normal_acceptance_rate !== null && B.normal_acceptance_rate !== null && A.normal_acceptance_rate - B.normal_acceptance_rate <= LIVE_GATES.b_normal_acceptance_drop &&
        bRatio !== null && bRatio <= LIVE_GATES.b_cost_ratio,
      c_accepted: manifest.arms.includes('C') ? safety(C) && C.completion_rate - B.completion_rate >= LIVE_GATES.c_completion_gain && cRatio !== null && cRatio <= LIVE_GATES.c_cost_ratio : null };
  }
  const realObservations = observations.mode === 'live_observations' && manifest.preflight.model_source === 'real_configured_service_chain';
  const complete = realObservations &&
    missing === 0 && disagreements === 0 && !observations.halted && rows.every(r => r.condition_verified === true && r.duplicate_execution === false) &&
    new Set(manifest.plan.map(t => t.case_id)).size >= LIVE_GATES.minimum_questions && manifest.plan.every(t => t.repeat < 3) &&
    Math.max(...manifest.plan.map(t => t.repeat)) + 1 >= LIVE_GATES.minimum_repetitions;
  return { mode: 'live_blind_scoring', experiment_digest: manifest.experiment_digest, model_quality_evaluated: realObservations && missing === 0 && disagreements === 0,
    evaluated_arms: manifest.arms, opencode_evaluated: manifest.arms.includes('C'),
    gates: LIVE_GATES, missing_double_annotations: missing, disagreements, comparisons,
    reviewer_accepted: complete && Object.values(comparisons).every(c => c.b_accepted),
    live_accepted: complete && manifest.arms.includes('C') && manifest.preflight.isolation_verified && Object.values(comparisons).every(c => c.b_accepted && c.c_accepted),
    decision: complete ? 'apply_preregistered_gates' : 'pending_or_incomplete_evidence',
    limitation: 'Point estimates and Wilson intervals are reported; paired/repeated observations are not independent trials and this report makes no significance claim. No revision or recovery success is inferred from untested cases.' };
}

export function scoreLiveFiles(observationsPath, labelsPath) {
  return scoreLiveObservations(readBoundedJson(resolve(observationsPath), 128 * 1024 * 1024).value, readBoundedJson(resolve(labelsPath)).value);
}
