// Explicit live driver only. Uses the production admission, worker, receipt and
// publication chain in a labeled disposable deployment; never calls a supplier.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { enqueueResearchJob } from '../../../src/lib/server/agent-queue.ts';
import { convergeExpiredRun, hashCanonical } from '../../../src/lib/server/agent-runs.ts';
import { cancelResearchJob } from '../../../src/lib/server/agent-research-status.ts';
import { selectResearchSeeds, materialFingerprint } from '../../../src/lib/server/agent-context.ts';
import { mapAgentItem } from '../../../src/lib/server/agent-retrieval.ts';
import { validateReviewReport } from '../../../src/lib/server/agent-review.ts';

function requireFact(condition, code) { if (!condition) throw new Error(code); }
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim();
const environment = row => Object.fromEntries((row.Config.Env ?? []).map(s => { const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)]; }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function verifyRuntimeProfile(runtime, isolation) {
  requireFact(!runtime.Config.Env.some(e => /^(?:[A-Z_]*API_KEY|DATABASE_URL|AGENT_DATA_TOKEN|AGENT_SERVICE_TOKEN|OPENCODE_WORKER_TOKEN|OPENCODE_BRIDGE_CONTROL_TOKEN)=/.test(e)), 'runtime_contains_privileged_credentials');
  requireFact(runtime.Image === isolation.runtime_image_id && runtime.HostConfig.ReadonlyRootfs && ['node', '1000', '1000:1000'].includes(runtime.Config.User) &&
    runtime.HostConfig.CapDrop?.includes('ALL') && runtime.HostConfig.SecurityOpt?.some(v => v.startsWith('no-new-privileges')) && !runtime.HostConfig.Binds?.length &&
    !Object.values(runtime.NetworkSettings.Ports ?? {}).some(ports => ports?.length), 'runtime_security_profile_mismatch');
  requireFact(runtime.HostConfig.Init === true && runtime.HostConfig.PidsLimit > 0 && runtime.HostConfig.PidsLimit <= isolation.security.pids_limit &&
    runtime.HostConfig.Memory > 0 && runtime.HostConfig.Memory <= isolation.security.memory &&
    ['/state', '/tmp'].every(path => typeof runtime.HostConfig.Tmpfs?.[path] === 'string' && ['noexec', 'nosuid'].every(flag => runtime.HostConfig.Tmpfs[path].split(',').includes(flag))),
  'runtime_resource_profile_mismatch');
}

export function verifyIsolationHost(info, host, isolation) {
  requireFact(host && isolation.deployment_host && hashCanonical(host) === hashCanonical(isolation.deployment_host) &&
    isolation.observed_at === host.verified_at && info.ID === host.docker_id && info.ServerVersion === host.docker_version &&
    info.OSType + '/' + info.Architecture === host.platform && isolation.docker_version === info.ServerVersion &&
    Date.now() - Date.parse(host.verified_at) >= 0 && Date.now() - Date.parse(host.verified_at) < 24 * 60 * 60 * 1000,
  'fresh_deployment_host_isolation_proof_required');
}

export async function createLiveAdapter(config, isolation) {
  const withOpenCode = (config.arms ?? ['A', 'B', 'C']).includes('C');
  let hashes = [], runtime;
  if (withOpenCode) {
    const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
    verifyIsolationHost(info, config.isolation_host, isolation);
  }
  // Config names a Docker validation database file, never ambient DATABASE_URL.
  const database = JSON.parse(readFileSync(config.database_file, 'utf8'));
  requireFact(database.host === '127.0.0.1' && database.database === 'review' && database.user === 'postgres' &&
    database.container === config.containers.database && Number.isSafeInteger(database.port), 'isolated_database_required');
  const inspected = {};
  for (const [role, container] of Object.entries(config.containers).filter(([role]) => withOpenCode || ['database', 'app', 'eino'].includes(role))) {
    const [row] = JSON.parse(docker(['inspect', container]));
    requireFact(row.State.Running && ['agent-opencode', 'agent-quality-live'].includes(row.Config.Labels?.['weavesense.validation']), 'labeled_live_deployment_required');
    inspected[role] = row;
  }
  requireFact(JSON.stringify(inspected.database.NetworkSettings.Ports['5432/tcp']) === JSON.stringify([{ HostIp: '127.0.0.1', HostPort: String(database.port) }]), 'database_loopback_required');
  const app = environment(inspected.app), eino = environment(inspected.eino);
  const appDSN = new URL(app.DATABASE_URL);
  const databaseAliases = Object.values(inspected.database.NetworkSettings.Networks).flatMap(n => n.Aliases ?? []);
  requireFact((databaseAliases.includes(appDSN.hostname) || (appDSN.hostname === '127.0.0.1' && Number(appDSN.port) === database.port)) &&
    appDSN.pathname === '/review' && decodeURIComponent(appDSN.username) === database.user && decodeURIComponent(appDSN.password) === database.password &&
    appDSN.searchParams.get('options') === '-c search_path=' + config.schema, 'application_database_binding_mismatch');
  const boundURL = (raw, role, pathname, port) => {
    const url = new URL(raw);
    const aliases = Object.values(inspected[role].NetworkSettings.Networks).flatMap(n => n.Aliases ?? []);
    return ['http:', 'https:'].includes(url.protocol) && aliases.includes(url.hostname) && Number(url.port) === port && url.pathname === pathname && !url.username && !url.password && !url.search && !url.hash;
  };
  requireFact(boundURL(eino.AGENT_DATA_URL, 'app', '/api/internal/agent-data', 8080), 'live_service_endpoint_binding_mismatch');
  requireFact(Object.keys(inspected.app.NetworkSettings.Networks).some(network =>
    ['eino', 'database'].every(role => inspected[role].NetworkSettings.Networks[network])), 'live_service_network_binding_mismatch');
  requireFact(app.AUTO_ANALYZE !== 'true' && app.EXTRACT_AUTO !== 'true' && app.AGENT_WORKER_ENABLED === 'true' &&
    eino.AGENT_WORKER_ENABLED === 'true' && !eino.AGENT_MCP_CONFIG && (withOpenCode || app.AGENT_OPENCODE_WORKER_ENABLED !== 'true'), 'isolated_worker_configuration_required');
  requireFact(app.AGENT_DATA_TOKEN && app.AGENT_DATA_TOKEN === eino.AGENT_DATA_TOKEN && app.AGENT_SERVICE_TOKEN && app.AGENT_SERVICE_TOKEN === eino.AGENT_SERVICE_TOKEN, 'trusted_service_auth_binding_mismatch');
  requireFact([app.AGENT_MODEL_NAME, eino.AGENT_MODEL_NAME].every(m => m === config.model_profile.model) && eino.AGENT_MODEL_API_KEY, 'shared_model_profile_required');
  requireFact(Number(app.AGENT_EXECUTE_TIMEOUT_MS) === config.execution_timeout_ms && Number(eino.AGENT_EXECUTE_TIMEOUT_MS) === config.execution_timeout_ms &&
    app.AGENT_SKILL_SNAPSHOT_DIGEST === config.skill_snapshot_digest, 'shared_timeout_and_skills_required');
  if (withOpenCode) {
    const bridge = environment(inspected.bridge), control = environment(inspected.opencode_worker);
    runtime = inspected.runtime;
    const runtimeEnv = environment(runtime);
    requireFact(bridge.AGENT_DATA_URL === eino.AGENT_DATA_URL &&
      boundURL(control.OPENCODE_JOBS_URL, 'app', '/api/internal/opencode-jobs', 8080) && boundURL(control.OPENCODE_REVIEW_URL, 'eino', '/v1/review', 8791) &&
      boundURL(control.OPENCODE_RUNTIME_URL, 'runtime', '/', 4097) && boundURL(control.OPENCODE_BRIDGE_URL, 'bridge', '/', 8792) &&
      runtimeEnv.OPENCODE_BRIDGE_URL === control.OPENCODE_BRIDGE_URL, 'live_service_endpoint_binding_mismatch');
    requireFact(Object.keys(inspected.app.NetworkSettings.Networks).some(network =>
      ['bridge', 'opencode_worker'].every(role => inspected[role].NetworkSettings.Networks[network])), 'live_service_network_binding_mismatch');
    requireFact(app.AGENT_OPENCODE_WORKER_ENABLED === 'true', 'isolated_worker_configuration_required');
    requireFact(app.AGENT_DATA_TOKEN === bridge.AGENT_DATA_TOKEN &&
      app.OPENCODE_WORKER_TOKEN && app.OPENCODE_WORKER_TOKEN === control.OPENCODE_WORKER_TOKEN &&
      app.AGENT_SERVICE_TOKEN === control.AGENT_SERVICE_TOKEN && bridge.OPENCODE_BRIDGE_CONTROL_TOKEN &&
      bridge.OPENCODE_BRIDGE_CONTROL_TOKEN === control.OPENCODE_BRIDGE_CONTROL_TOKEN && runtimeEnv.OPENCODE_RUNTIME_TOKEN &&
      runtimeEnv.OPENCODE_RUNTIME_TOKEN === control.OPENCODE_RUNTIME_TOKEN, 'trusted_service_auth_binding_mismatch');
    requireFact([bridge.AGENT_MODEL_NAME, control.OPENCODE_MODEL_NAME, runtimeEnv.OPENCODE_MODEL_NAME].every(m => m === config.model_profile.model) &&
      eino.AGENT_MODEL_BASE_URL === bridge.AGENT_MODEL_BASE_URL && eino.AGENT_MODEL_API_KEY === bridge.AGENT_MODEL_API_KEY, 'shared_model_profile_required');
    verifyRuntimeProfile(runtime, isolation);
    const networks = Object.keys(runtime.NetworkSettings.Networks);
    requireFact(networks.length === 1, 'runtime_single_isolated_network_required');
    const [network] = JSON.parse(docker(['network', 'inspect', networks[0]]));
    requireFact(network.Internal && network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
      Object.entries(isolation.network_profile.docker_network_options).every(([key, value]) => network.Options?.[key] === value) &&
      [inspected.bridge, inspected.opencode_worker].every(row => row.NetworkSettings.Networks[networks[0]]), 'runtime_network_isolation_required');
    hashes = docker(['exec', config.containers.runtime, 'sha256sum', '/usr/local/bin/opencode', '/opt/runtime/server.mjs']).split('\n').map(line => line.split(/\s+/)[0]);
    requireFact(hashes[0] === isolation.production_artifact.binary_sha256 && hashes[1] === isolation.production_artifact.wrapper_sha256, 'runtime_artifact_mismatch');
  }
  // HTTP probes are limited to readiness / app rendering, never /execute or model routes.
  requireFact(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.services.eino_ready_url).hostname) && new URL(config.services.eino_ready_url).pathname === '/readyz', 'eino_readiness_loopback_required');
  const ready = await fetch(config.services.eino_ready_url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const facts = await ready.json();
  requireFact(ready.ok && facts.ok && facts.skill_snapshot_digest === config.skill_snapshot_digest && facts.protocol_version === 1, 'eino_readiness_mismatch');
  const appURL = new URL(config.services.app_url);
  requireFact(['127.0.0.1', 'localhost', '[::1]'].includes(appURL.hostname) && appURL.pathname === '/', 'live_app_loopback_required');
  const published = (row, port, url) => (row.NetworkSettings.Ports[port + '/tcp'] ?? []).some(p => p.HostIp === '127.0.0.1' && Number(p.HostPort) === Number(url.port));
  requireFact(published(inspected.app, 8080, appURL) && published(inspected.eino, 8791, new URL(config.services.eino_ready_url)), 'readiness_endpoint_binding_mismatch');
  requireFact((await fetch(new URL('/knowledge', appURL), { signal: AbortSignal.timeout(10000), redirect: 'error' })).ok, 'isolated_app_unavailable');
  const pool = new pg.Pool({ host: database.host, port: database.port, user: database.user, password: database.password,
    database: database.database, options: '-c search_path=' + config.schema, max: 2 });
  const sql = { query: async (text, params = []) => (await pool.query(text, params)).rows,
    transaction: async fn => {
      const connection = await pool.connect();
      try { await connection.query('begin'); const value = await fn({ query: async (text, params = []) => (await connection.query(text, params)).rows }); await connection.query('commit'); return value; }
      catch (error) { await connection.query('rollback'); throw error; }
      finally { connection.release(); }
    } };
  const corpus = async () => (await sql.query('select i.*,s.name as source_name from items i join sources s on s.id=i.source_id order by i.id')).map(mapAgentItem);
  const corpusDigest = items => hashCanonical(items.map(item => ({ id: item.id, fingerprint: materialFingerprint(item), collected_at: item.collected_at })));
  const deploymentDigest = rows => hashCanonical(rows.map(row => ({ id: row.Id, image: row.Image, env: hashCanonical(row.Config.Env),
    restart_count: row.RestartCount, running: row.State.Running, network: row.NetworkSettings.Networks, host: row.HostConfig })));
  const deploymentHash = deploymentDigest(Object.values(inspected));
  const deploymentStable = () => deploymentDigest(JSON.parse(docker(['inspect', ...Object.keys(inspected).map(role => config.containers[role])]))) === deploymentHash;
  let frozenItems;
  return {
    async prepare(_config, cases) {
      const [db] = await sql.query('select current_database() as db,current_schema() as schema');
      requireFact(db.db === 'review' && db.schema === config.schema, 'isolated_schema_missing');
      requireFact((await sql.query("select id from ai_jobs where status in ('queued','running')")).length === 0, 'live_schema_has_active_tasks');
      frozenItems = await corpus();
      requireFact(frozenItems.length && cases.every(c => c.source_ids.every(id => frozenItems.some(item => item.id === id))), 'holdout_corpus_missing');
      return { trusted_ledger: true, isolation_verified: withOpenCode, model_source: config.validation_only ? 'unit_test_fake' : 'real_configured_service_chain', corpus_digest: corpusDigest(frozenItems),
        isolation_host: config.isolation_host, isolation_evidence_sha256: config.isolation_evidence_sha256, deployment_digest: deploymentHash,
        database_scope: config.schema, runtime_image: runtime?.Image, binary_sha256: hashes[0], wrapper_sha256: hashes[1],
        model_endpoint_digest: hashCanonical(eino.AGENT_MODEL_BASE_URL), service_configuration_digest: hashCanonical({
          app: inspected.app.Image, eino: inspected.eino.Image, worker: inspected.opencode_worker?.Image, bridge: inspected.bridge?.Image,
          endpoint: eino.AGENT_MODEL_BASE_URL, model: config.model_profile.model, skill: facts.skill_snapshot_digest,
        }), limitations: ['Deployment-host isolation evidence must be refreshed for changed images/networks.', 'Ready probes do not establish supplier model quality or latency.'] };
    },
    async execute(task, _config, prepared) {
      requireFact(deploymentStable(), 'frozen_deployment_changed');
      requireFact(corpusDigest(await corpus()) === prepared.corpus_digest, 'frozen_corpus_changed');
      const selected = selectResearchSeeds(task.source_ids.map(id => frozenItems.find(item => item.id === id)), task.question);
      requireFact(selected.sources.length > 0, 'holdout_evidence_missing');
      const profile = { model: config.model_profile.model, input_per_million: config.model_profile.input_per_million,
        output_per_million: config.model_profile.output_per_million, price_version: config.model_profile.price_version };
      const reviewPolicy = { mode: task.review_mode, version: 'loom-agent-v1', question: task.question, model: profile.model,
        max_output_tokens_per_call: 1800, model_profile_digest: hashCanonical(profile), skill_snapshot_digest: config.skill_snapshot_digest };
      const snapshot = { governed: true, provider: task.provider, scope: 'corpus', range: null, sources: selected.sources,
        skill_snapshot_digest: config.skill_snapshot_digest, model_profile: profile, review_policy: reviewPolicy, role_limits: task.role_limits,
        policy: { version: 'loom-agent-v1', max_model_calls: task.total_model_calls, max_tool_calls: 4, max_output_tokens_per_call: 1800 },
        budget: { dailyLimit: 10000, dailyBudgetRmb: config.experiment_budget_cny, priceVersion: profile.price_version,
          worstCostRmb: task.worst_cost_cny, pricing: { ...profile, max_input_tokens_per_call: 512 * 1024, max_output_tokens_per_call: 1800 } } };
      const oldExecution = process.env.AGENT_EXECUTE_TIMEOUT_MS, oldQueue = process.env.AGENT_RESEARCH_QUEUE_TTL_MS;
      let queued;
      try {
        process.env.AGENT_EXECUTE_TIMEOUT_MS = String(config.execution_timeout_ms); process.env.AGENT_RESEARCH_QUEUE_TTL_MS = String(config.queue_ttl_ms);
        queued = await enqueueResearchJob(sql, { question: task.question, requestId: task.request_id, materialHash: selected.materialHash, snapshot });
      } finally {
        if (oldExecution === undefined) delete process.env.AGENT_EXECUTE_TIMEOUT_MS; else process.env.AGENT_EXECUTE_TIMEOUT_MS = oldExecution;
        if (oldQueue === undefined) delete process.env.AGENT_RESEARCH_QUEUE_TTL_MS; else process.env.AGENT_RESEARCH_QUEUE_TTL_MS = oldQueue;
      }
      if (!queued) return { status: 'not_sent', condition_verified: true, duplicate_execution: false, error_code: 'host_budget_denied', actual_cost_cny: 0,
        model_calls: [], candidate: null, evidence: selected.sources, latency_ms: 0 };
      requireFact(queued.kind === 'won', 'fresh_request_required');
      const start = Date.now(), until = start + config.execution_timeout_ms + config.queue_ttl_ms + 5000;
      let row;
      while (Date.now() < until) {
        [row] = await sql.query('select * from ai_jobs where id=$1', [queued.id]);
        if (row.run_id) await convergeExpiredRun(sql, row.run_id);
        if (!['queued', 'running'].includes(row.status)) break;
        if (row.status === 'queued' && Date.parse(row.payload.queue_expires_at) <= Date.now()) await cancelResearchJob(sql, row.id, true);
        await pause(250);
      }
      [row] = await sql.query('select * from ai_jobs where id=$1', [queued.id]);
      if (['queued', 'running'].includes(row.status)) await cancelResearchJob(sql, row.id, true);
      const [run] = row.run_id ? await sql.query('select * from ai_runs where id=$1', [row.run_id]) : [];
      const [candidate] = run ? await sql.query('select * from ai_research_candidates where run_id=$1', [run.id]) : [];
      const [review] = run ? await sql.query('select * from ai_research_reviews where run_id=$1', [run.id]) : [];
      const calls = run ? await sql.query('select call_id,role,state,model,policy_version,input_tokens,output_tokens,request_digest from ai_model_calls where run_id=$1 order by started_at,call_id', [run.id]) : [];
      const [reservation] = await sql.query('select status,actual_rmb,reserved_rmb,dispatch_state,pricing from ai_budget_reservations where job_id=$1', [row.id]);
      const [notes] = await sql.query('select count(*)::int as n from knowledge_notes where run_id=$1', [run?.id ?? '']);
      const checked = candidate && review?.report_json ? validateReviewReport(JSON.stringify(review.report_json), {
        run_id: run.id, candidate: candidate.result_json, evidence: candidate.evidence_json, policy: candidate.frozen_policy,
      }) : null;
      const verified = Boolean(run && run.provider === task.provider && run.request_json.governed &&
        hashCanonical(run.request_json.model_profile) === hashCanonical(profile) && hashCanonical(run.request_json.role_limits) === hashCanonical(task.role_limits) &&
        hashCanonical(run.request_json.sources) === hashCanonical(selected.sources) && hashCanonical(run.request_json.review_policy) === hashCanonical(reviewPolicy) &&
        run.request_json.skill_snapshot_digest === config.skill_snapshot_digest && calls.every(c => c.model === profile.model) &&
        corpusDigest(await corpus()) === prepared.corpus_digest && deploymentStable());
      return { job_id: row.id, run_id: run?.id, status: ['queued', 'running'].includes(row.status) ? 'outcome_unknown' : row.status,
        error_code: row.error_code, condition_verified: verified, duplicate_execution: notes.n > 1 || calls.length > task.total_model_calls ||
          ['producer', 'reviewer'].some(role => calls.filter(c => c.role === role).length > task.role_limits[role]) ||
          new Set(calls.map(c => c.role + ':' + c.request_digest)).size !== calls.length,
        actual_cost_cny: ['settled', 'released'].includes(reservation?.status) ? Number(reservation.actual_rmb) : null,
        reservation_state: reservation?.status, model_calls: calls, candidate: candidate?.result_json ?? null,
        evidence: candidate?.evidence_json ?? selected.sources, candidate_digest: candidate?.candidate_digest,
        report: review?.report_json ?? null, review_valid: checked?.ok === true, review_blocked: checked?.ok ? checked.blocked : true,
        review_state: review?.state, latency_ms: Date.now() - start, recovery_attempted: Number(row.attempts) > 1,
        recovery_succeeded: Number(row.attempts) > 1 && row.status === 'succeeded',
        runtime_intervention: { prompt_version: run?.prompt_version, skill_versions: run?.skill_versions,
          producer_window_ms: run ? Date.parse(run.request_json.producer_deadline_at) - Date.parse(run.created_at) : null,
          final_deadline_at: run?.expires_at, review_deadline_at: run?.request_json.review_deadline_at } };
    },
    close: () => pool.end(),
  };
}
