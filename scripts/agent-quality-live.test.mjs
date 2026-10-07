import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { executeLive, livePlan, loadLiveConfig, scoreLiveObservations } from './agent-quality-live.mjs';
import { verifyRuntimeProfile, verifyIsolationHost } from '../validation/agent/opencode/live-eval-adapter.mjs';
import { hashCanonical } from '../src/lib/server/agent-runs.ts';

const config = (arms = ['A', 'B', 'C']) => ({ schema_version: 1, experiment_id: randomUUID(), arms,
  holdout_file: 'holdout.json', holdout_sha256: 'a'.repeat(64), database_file: 'database.json', schema: 'oc_live_quality_test',
  model_profile: { model: 'test-model-20261007', model_revision: 'test-model-20261007', input_per_million: .001, output_per_million: .002, price_version: 'test-price-v1' },
  skill_snapshot_digest: 'b'.repeat(64), repetitions: 1, execution_timeout_ms: 10000, queue_ttl_ms: 1000,
  services: { app_url: 'http://127.0.0.1:18080/', eino_ready_url: 'http://127.0.0.1:18791/readyz' },
  containers: { database: 'test-db', app: 'test-app', eino: 'test-eino' },
  ...(arms.includes('C') ? { containers: { database: 'test-db', app: 'test-app', eino: 'test-eino', opencode_worker: 'test-worker', bridge: 'test-bridge', runtime: 'test-runtime' },
    isolation_evidence_file: 'proof.json', isolation_evidence_sha256: 'c'.repeat(64), isolation_host: { docker_id: 'test-host', docker_version: 'test-version', platform: 'linux/x86_64', verified_at: new Date().toISOString() } } : {}) });
const cases = count => Array.from({ length: count }, (_, i) => ({ id: 'case-' + i, question: '评估冻结资料 ' + i, source_ids: ['source-' + i] }));
const labelsFor = (observations, facts = () => ({})) => ({ schema_version: 1, experiment_digest: observations.manifest.experiment_digest,
  blinded: true, independent: true, annotations: observations.results.flatMap(row => ['human-1', 'human-2'].map(grader_id => ({
    blind_id: row.blind_id, candidate_digest: hashCanonical(row.candidate), grader_id,
    defective: false, hard_error: false, task_accepted: true, evidence_support: true, conflict_handling: true,
    defect_class: 'normal', defect_localized: null, ...facts(row, grader_id),
  }))) });
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weavesense-quality-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeAdapter(observation = () => ({}), modelSource = 'unit_test_fake') {
  const counts = { prepare: 0, execute: 0 };
  return { counts,
    prepare: async () => { counts.prepare++; return { trusted_ledger: true, isolation_verified: true, corpus_digest: 'd'.repeat(64), model_source: modelSource }; },
    execute: async task => {
      counts.execute++;
      assert.equal('expected_blocked' in task, false);
      assert.equal('label' in task, false);
      return { status: 'succeeded', actual_cost_cny: .00001, model_calls: [{ role: 'producer', state: 'completed', input_tokens: '10', output_tokens: '5' }],
        candidate: { summary: 'Synthetic output; no quality claim.' }, evidence: [{ id: 'test-evidence' }],
        condition_verified: true, duplicate_execution: false, report: { findings: [], checks: [{ status: 'not_checked' }] },
        review_valid: true, review_blocked: false, latency_ms: 10, ...observation(task) };
    },
  };
}
const runFake = (t, cfg = config(), adapter = fakeAdapter(), count = 1) => executeLive(cfg, cases(count), { maxCases: count, budgetCny: 10 }, adapter, workspace(t));

test('insufficient paired budget makes zero admissions and zero adapter preparations', async t => {
  const cfg = config(), adapter = fakeAdapter(), directory = join(workspace(t), 'not-created');
  await assert.rejects(executeLive(cfg, cases(1), { maxCases: 1, budgetCny: .0001 }, adapter, directory), /budget_insufficient_for_paired_plan/);
  assert.deepEqual(adapter.counts, { prepare: 0, execute: 0 });
  assert.equal(existsSync(directory), false);
});

test('both comparisons explicitly separate Producer parity from total parity; AB needs no OpenCode', async t => {
  const cfg = config(['A', 'B']), plan = livePlan(cfg, cases(2), 2);
  assert.equal(plan.length, 8);
  assert.equal(plan.some(row => row.group === 'C'), false);
  for (const row of plan) {
    assert.equal(row.total_model_calls, row.group === 'B' && row.comparison === 'same_producer_budget' ? 7 : 6);
    assert.equal(row.role_limits.producer, row.group === 'B' && row.comparison === 'equal_total_budget' ? 5 : 6);
    assert.equal(row.role_limits.reviewer, row.group === 'A' ? 0 : 1);
  }
  const result = await runFake(t, cfg);
  const scored = scoreLiveObservations(result, labelsFor(result));
  assert.equal(scored.opencode_evaluated, false);
  assert.equal(scored.live_accepted, false);
  assert.equal(scored.model_quality_evaluated, false);
});

test('manifest is frozen before admission and blind outputs exclude Reviewer verdict, arm and ledger', async t => {
  const directory = workspace(t), cfg = config();
  const adapter = fakeAdapter(task => {
    const frozen = JSON.parse(readFileSync(join(directory, 'preregistered.json')));
    assert.deepEqual(frozen.plan.find(row => row.blind_id === task.blind_id), task);
    return { group: 'model-controlled-arm', blind_id: randomUUID() };
  });
  const result = await executeLive(cfg, cases(1), { maxCases: 1, budgetCny: 10 }, adapter, directory);
  assert.equal(result.results.length, 6);
  assert.deepEqual(result.results.map(row => row.group), result.manifest.plan.map(row => row.group));
  const blind = JSON.parse(readFileSync(join(directory, 'blind-candidates.json')));
  assert.equal(blind.candidates.length, 6);
  for (const row of blind.candidates) assert.deepEqual(Object.keys(row).sort(), ['blind_id', 'candidate', 'candidate_digest', 'evidence', 'question']);
  assert.equal(existsSync(join(directory, 'blind-review-findings.json')), true);
  assert.equal(result.live_accepted, false);
});

test('unknown usage halts after one dispatch, retains all failure slots and never retries', async t => {
  const adapter = fakeAdapter(() => ({ status: 'outcome_unknown', actual_cost_cny: null, model_calls: [{ role: 'producer', state: 'outcome_unknown', input_tokens: null, output_tokens: null }] }));
  const result = await runFake(t, config(), adapter);
  assert.equal(adapter.counts.execute, 1);
  assert.equal(result.results.length, 6);
  assert.equal(result.results.filter(row => row.status === 'not_sent').length, 5);
  assert.equal(result.budget.unknown_reserved_cny, result.manifest.plan[0].worst_cost_cny);
  assert.equal(result.halted, true);
  assert.equal(scoreLiveObservations(result, labelsFor(result)).live_accepted, false);
});

test('malformed receipts remain unknown, rather than crashing and losing a charged attempt', async t => {
  const adapter = fakeAdapter();
  adapter.execute = async () => { adapter.counts.execute++; return { actual_cost_cny: 0 }; };
  const result = await runFake(t, config(), adapter);
  assert.equal(adapter.counts.execute, 1);
  assert.equal(result.results[0].status, 'outcome_unknown');
  assert.equal(result.results[0].actual_cost_cny, null);
});

test('strict holdout input has no human answer keys and rejects oversized questions before dispatch', t => {
  const directory = workspace(t), cfg = config(['A', 'B']);
  function save(holdout) {
    const bytes = JSON.stringify(holdout);
    writeFileSync(join(directory, 'holdout.json'), bytes);
    cfg.holdout_sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'config.json'), JSON.stringify(cfg));
    return join(directory, 'config.json');
  }
  assert.deepEqual(loadLiveConfig(save({ schema_version: 1, cases: cases(1) })).config.arms, ['A', 'B']);
  for (const extra of [{ expected_blocked: true }, { rationale: 'human answer key' }, { candidate: {} }, { label: false }]) {
    assert.throws(() => loadLiveConfig(save({ schema_version: 1, cases: [{ ...cases(1)[0], ...extra }] })));
  }
  assert.throws(() => loadLiveConfig(save({ schema_version: 1, cases: [{ ...cases(1)[0], question: 'x'.repeat(401) }] })));
  cfg.model_profile.model_revision = 'different-version';
  assert.throws(() => loadLiveConfig(save({ schema_version: 1, cases: cases(1) })), /explicit_model_revision_required/);
});

test('missing, disagreeing and misbound human labels cannot pass; failures cannot disappear', async t => {
  const result = await runFake(t);
  assert.equal(scoreLiveObservations(result, { ...labelsFor(result), annotations: [] }).live_accepted, false);
  const disagreeing = labelsFor(result, (_row, grader) => ({ task_accepted: grader === 'human-1' }));
  assert.equal(scoreLiveObservations(result, disagreeing).disagreements, 6);
  const wrongDigest = labelsFor(result); wrongDigest.annotations[0].candidate_digest = 'f'.repeat(64);
  assert.throws(() => scoreLiveObservations(result, wrongDigest), /annotation_binding_mismatch/);
  const dropped = structuredClone(result); dropped.results.pop();
  assert.throws(() => scoreLiveObservations(dropped, labelsFor(result)), /missing_or_duplicate_observation/);
  const altered = JSON.parse(JSON.stringify(result)); altered.results[0].role_limits.producer = 999;
  assert.throws(() => scoreLiveObservations(altered, labelsFor(result)), /observation_plan_mismatch/);
});

test('zero defect denominators and any published hard error reject adoption; fake runs never establish quality', async t => {
  const cfg = config(); cfg.repetitions = 2;
  const result = await runFake(t, cfg, fakeAdapter(), 30);
  const scored = scoreLiveObservations(result, labelsFor(result));
  assert.equal(scored.model_quality_evaluated, false);
  assert.equal(scored.reviewer_accepted, false);
  assert.equal(scored.comparisons.same_producer_budget.metrics.B.blocking_recall, null);
  assert.equal(scored.comparisons.same_producer_budget.b_relative_defect_reduction, null);
  const hard = scoreLiveObservations(result, labelsFor(result, row => ({ hard_error: row.group === 'B' })));
  assert.ok(hard.comparisons.same_producer_budget.metrics.B.hard_error_publications > 0);
  assert.equal(hard.live_accepted, false);
  assert.equal(scored.comparisons.same_producer_budget.metrics.A.tokens.producer.input, 600);
});

test('AB gates can pass independently; blocking normal tasks or publishing a hard error refuses adoption', async t => {
  const cfg = config(['A', 'B']); cfg.repetitions = 2;
  const defect = row => Number(row.case_id.slice(5)) < 10;
  const adapter = fakeAdapter(row => ({ status: row.group === 'B' && defect(row) ? 'review_blocked' : 'succeeded', review_blocked: row.group === 'B' && defect(row) }), 'real_configured_service_chain');
  const result = await runFake(t, cfg, adapter, 30);
  const facts = row => ({ defective: defect(row), task_accepted: !defect(row), defect_class: defect(row) ? 'date_scope' : 'normal', defect_localized: defect(row) ? true : null });
  const scored = scoreLiveObservations(result, labelsFor(result, facts));
  assert.equal(scored.reviewer_accepted, true);
  assert.equal(scored.live_accepted, false);
  assert.equal(scored.opencode_evaluated, false);
  assert.equal(scoreLiveObservations(result, labelsFor(result, row => ({ ...facts(row), hard_error: row.group === 'B' && !defect(row) }))).reviewer_accepted, false);
  const blockedNormals = JSON.parse(JSON.stringify(result));
  for (const row of blockedNormals.results) if (row.group === 'B') row.status = 'review_blocked';
  assert.equal(scoreLiveObservations(blockedNormals, labelsFor(blockedNormals, facts)).reviewer_accepted, false);
});

test('runtime preflight rejects master secrets and drift from the attested resource profile', () => {
  const proof = { runtime_image_id: 'same-image', security: { memory: 1024, pids_limit: 64 } };
  const runtime = { Image: 'same-image', Config: { Env: ['OPENCODE_RUNTIME_TOKEN=scoped'], User: 'node' },
    HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Init: true, Memory: 1024, PidsLimit: 64,
      Tmpfs: { '/state': 'noexec,nosuid,size=1m', '/tmp': 'noexec,nosuid,size=1m' } }, NetworkSettings: { Ports: {} } };
  verifyRuntimeProfile(runtime, proof);
  for (const secret of ['AGENT_SERVICE_TOKEN', 'OPENCODE_BRIDGE_CONTROL_TOKEN', 'AGENT_DATA_TOKEN', 'OPENCODE_WORKER_TOKEN', 'AGENT_MODEL_API_KEY', 'DATABASE_URL']) {
    const changed = structuredClone(runtime); changed.Config.Env.push(secret + '=forbidden');
    assert.throws(() => verifyRuntimeProfile(changed, proof), /runtime_contains_privileged_credentials/);
  }
  for (const mutation of [r => { r.HostConfig.Init = false; }, r => { r.HostConfig.PidsLimit = 65; }, r => { r.HostConfig.Memory = 2048; }, r => { r.HostConfig.Tmpfs['/tmp'] = 'nosuid'; }]) {
    const changed = structuredClone(runtime); mutation(changed);
    assert.throws(() => verifyRuntimeProfile(changed, proof), /runtime_resource_profile_mismatch/);
  }
});

test('isolation proof binds the current host and fresh observation rather than a portable image hash', () => {
  const host = { docker_id: 'current-daemon', docker_version: 'current-version', platform: 'linux/x86_64', verified_at: new Date(Date.now() - 1000).toISOString() };
  const info = { ID: host.docker_id, ServerVersion: host.docker_version, OSType: 'linux', Architecture: 'x86_64' };
  const proof = { deployment_host: { ...host }, docker_version: host.docker_version, observed_at: host.verified_at };
  verifyIsolationHost(info, host, proof);
  assert.throws(() => verifyIsolationHost({ ...info, ID: 'other-daemon' }, host, proof), /fresh_deployment_host/);
  assert.throws(() => verifyIsolationHost({ ...info, Architecture: 'aarch64' }, host, proof), /fresh_deployment_host/);
  assert.throws(() => verifyIsolationHost(info, host, { ...proof, observed_at: new Date(0).toISOString() }), /fresh_deployment_host/);
  const stale = { ...host, verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
  assert.throws(() => verifyIsolationHost(info, stale, { ...proof, deployment_host: stale, observed_at: stale.verified_at }), /fresh_deployment_host/);
  assert.throws(() => verifyIsolationHost(info, host, { ...proof, deployment_host: undefined }), /fresh_deployment_host/);
});
