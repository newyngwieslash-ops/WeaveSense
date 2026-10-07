# Research quality evaluation policy v1

This policy is a proposed, pre-live baseline. No live model has been evaluated by
the offline fixture run. Changing thresholds after observing live results requires
a new policy version and a new experiment, not relabeling the old run as passing.

## What is implemented

`node --experimental-strip-types scripts/agent-quality-eval.mjs --offline` validates 30 hand-authored synthetic
cases and their separately stored reviewer fixtures: 18 defective candidates and
12 reasonable candidates across six defect classes. Each case includes source
text, the candidate, its label, the labeling rationale, and a reviewer fixture.
These examples are contract/scoring checks, not a held-out model benchmark.
Fixtures deliberately include exact quotations supporting a different conclusion:
passing substring citation validation does not prove semantic support.

The runner validates the actual review contract, host-computed candidate/evidence/
policy digests, claim locations, and allowed evidence IDs. It then scores fixture
decisions against labels. It makes zero model calls, reads no provider credentials,
and emits `model_quality_evaluated: false`. A missing/invalid report never becomes a
pass. Mismatched fixtures produce a nonzero CLI exit.

The live driver now enqueues through the existing production admission, worker,
candidate, independent Reviewer, ledger and publication functions in an explicitly
configured disposable deployment. It does not call a provider directly or fall
back to ambient credentials. The driver and adapter smoke tests use fake model
replies; they are not observations of supplier quality. No paid evaluation has
been performed as part of implementing this entry point.

Live usage has an explicit bounded argument shape. Run A/B before requiring
OpenCode; set `arms` to `["A","B","C"]` to add C:

```text
node --experimental-strip-types scripts/agent-quality-eval.mjs --live --max-cases=30 --budget-cny=2000 --config=.repo/quality-live.local.json
```

`max-cases` must be an integer from 1 to 100; `budget-cny` must be a finite decimal
greater than 0 and at most 10,000. The budget is mandatory; increasing this tool's
input ceiling does not authorize a paid run. Repetitions must be 1–3. Before the
first admission, the driver freezes every paired task and verifies that the
whole plan's conservative worst cost fits the explicit budget. Insufficient
budget sends zero tasks; it never drops an expensive arm to finish a partial,
unfair comparison. The 512 KiB input bound and 1,800 output tokens per call remain
conservative bounds, so a complete repeated experiment may reserve substantially
more than its eventual measured cost. The same frozen rates and limits enter
the host's real budget reservations and daily admission locks. Unknown usage
retains its reservation, stops the experiment, and never starts an SDK retry.

### Explicit local configuration

Provision a separate validation PostgreSQL database named `review`, a fresh
`oc_live_` schema with all project migrations, and a frozen imported corpus. All
selected `source_ids` below are material/item IDs in that corpus, not source
table IDs. Run an app and Eino worker against that exact schema, with Docker label
`weavesense.validation=agent-quality-live` (the existing `agent-opencode` validation
label is also accepted). Publish PostgreSQL, the app, and Eino readiness only on
loopback. This driver deliberately does not create or reconfigure deployments.
Unlabeled production containers and a production database are rejected.

The A/B config is a strict JSON object; replace the example model, prices,
hashes, IDs, ports and container names with the explicitly provisioned values:

```json
{
  "schema_version": 1,
  "experiment_id": "c82ba5a8-8b35-4b17-9a12-8f44bfe6a780",
  "arms": ["A", "B"],
  "holdout_file": "quality-holdout.local.json",
  "holdout_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "database_file": "quality-database.local.json",
  "schema": "oc_live_quality_20261007",
  "model_profile": {
    "model": "provider-model-20261001",
    "model_revision": "provider-model-20261001",
    "input_per_million": 1,
    "output_per_million": 4,
    "price_version": "provider-price-20261007"
  },
  "skill_snapshot_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "repetitions": 2,
  "execution_timeout_ms": 120000,
  "queue_ttl_ms": 10000,
  "services": {
    "app_url": "http://127.0.0.1:18080/",
    "eino_ready_url": "http://127.0.0.1:18791/readyz"
  },
  "containers": {
    "database": "quality-postgres",
    "app": "quality-app",
    "eino": "quality-eino"
  }
}
```

Paths resolve relative to the config file. The database file is the validation
database descriptor `{host:"127.0.0.1",port,user:"postgres",password,
database:"review",container}`; keep it local and uncommitted. The adapter verifies
the actual app DSN, schema and container port against it. Supplier credentials
remain in the trusted Eino service, and for C the bridge; no provider token is
read from the evaluator's environment or written to evaluation artifacts.

Match the actual app/Eino model name and execution timeout to this config; pin a
stable dated model revision, not a mutable alias. `model_revision` must equal the
requested model name. The recorded requested revision does not independently
prove an upstream provider's undisclosed internal revision. Match the app and
Eino Skill snapshot. Enable Eino workers, disable auto analysis/extraction, and
for A/B disable the OpenCode worker. Match the app's data/service credentials to
Eino, and bind Eino data access to the labeled app. No external MCP configuration
is admitted. Readiness and app rendering probes make no model calls.

Create a separate holdout file with no candidate, Reviewer result, labels,
expected verdict or rationale. Its strict shape is:

```json
{"schema_version":1,"cases":[{"id":"question-01","question":"冻结资料中两种结论是否存在矛盾？","source_ids":["material-id-01","material-id-02"]}]}
```

Questions have 2–400 UTF-16 code units; each case has 1–8 unique material IDs;
holdout IDs are unique. Freeze SHA-256 of the complete file bytes before running
(on PowerShell, `(Get-FileHash .repo/quality-holdout.local.json -Algorithm SHA256).Hash.ToLower()`).
The entire stored corpus is fingerprinted; each arm receives the same deterministic
seed selection for its question. Changing corpus bytes, model/Skill configuration,
container identity, runtime image, restart count or networking halts the experiment.

### OpenCode preflight

A/B uses only the app, database and Eino; C is explicitly unmeasured. Adding C
requires `containers.opencode_worker`, `containers.bridge`, `containers.runtime`,
`isolation_evidence_file`, its complete-byte `isolation_evidence_sha256`, and
`isolation_host` copied from the fresh proof's `deployment_host`. That object has
`docker_id`, `docker_version`, `platform` and `verified_at`. Re-run the existing
`validation/agent/opencode/isolation.test.mjs` probe on the deployment host before
running C, then freeze its resulting proof. The adapter verifies the proof's
observation timestamp and host metadata against current Docker daemon info and
requires it to be less than 24 hours old. A matching binary/image hash alone
does not establish isolation on another host. Historical proof cannot be reused
across Docker hosts, platforms, stale runs or changed profiles.

Actual containers must also match the attested production binary/wrapper/image,
one internal isolated runtime network with bridge/control bindings, a read-only
non-root runtime, no host binds or published ports, dropped capabilities,
no-new-privileges, init, bounded memory/PIDs and noexec/nosuid tmpfs. Runtime env
must not contain supplier API keys, database credentials, data/service master
tokens, worker or bridge-control tokens. Its runtime token is narrowly scoped.
The adapter checks endpoint, auth, shared model/price/Skill and timeout bindings
without exporting original environment values. Missing proof fails before any
model dispatch; there is no direct-provider fallback.

### Artifacts and separate human scoring

The driver writes a preregistered manifest before any admission, every observed
result, and `.repo/agent-quality-live/<experiment_id>/observations.json`. Output
files are created exclusively; use a new experiment ID for a new run. Jobs with
runtime failures, blocked publication, unknown calls or unstarted slots remain
in the original paired denominator. All call IDs, role receipts, known/unknown
costs, candidate, evidence, Reviewer report and runtime intervention facts come
from the persisted production ledger. A transport failure is retained as unknown
and halts further dispatch; inspect its persisted job rather than retrying it.

Give independent human graders only `blind-candidates.json` first. It includes
failed/null candidates and evidence but no arm, runtime, receipt cost, Reviewer
verdict or answer key. Freeze their candidate-quality judgments before opening
the separate `blind-review-findings.json` for defect-localization annotation.
Do not give graders the manifest, observation files or synthetic fixture labels.
Human annotations are a separate strict file, never sent to the model:

```json
{
  "schema_version": 1,
  "experiment_digest": "<preregistered experiment SHA-256>",
  "blinded": true,
  "independent": true,
  "annotations": [{
    "blind_id": "<blind UUID>", "candidate_digest": "<blind candidate SHA-256>",
    "grader_id": "independent-human-01", "defective": false,
    "hard_error": false, "task_accepted": true, "evidence_support": true,
    "conflict_handling": true, "defect_class": "normal", "defect_localized": null
  }]
}
```

Require two distinct human graders agreeing on every candidate's facts. Valid
defect classes are the six classes below plus `normal`; `defect_localized` is a
human judgment or `null` if not measured. The evaluator binds every observation
to its full frozen plan and every annotation to its candidate digest; missing,
duplicate or misbound observations/graders cannot silently disappear. Grade
null candidates as unsuccessful tasks; do not invent semantic defects where no
candidate exists. Disagreements and missing annotations remain unresolved.

```text
node --experimental-strip-types scripts/agent-quality-eval.mjs --score-live=.repo/agent-quality-live/<id>/observations.json --labels=.repo/quality-human-labels.local.json
```

No labels or no real observations yields pending evidence and false acceptance.
At least 30 distinct held-out questions and two repeated paired runs are needed
for adoption scoring. A/B can establish `reviewer_accepted` independently;
without C, `opencode_evaluated=false`, C gates are `null`, and `live_accepted=false`.
Fake driver/adapter validation always has `model_quality_evaluated=false` and
cannot pass either adoption flag. A final failed/pending adoption score exits
nonzero; it does not change production flags or rewrite `decision.md`.

## Measurements and denominator rules

- True positive: defective candidate, valid report, blocked decision.
- False negative: defective candidate without a valid blocking report. Invalid
  reports are counted here as missed semantic detection, even though publication
  remains blocked. This prevents garbage output from improving recall.
- False positive: reasonable candidate blocked, including an invalid report.
- True negative: reasonable candidate with a valid nonblocking report.
- Blocking recall: true positives / defective candidates.
- False-block rate: false positives / reasonable candidates.
- Unsafe acceptances: defective candidates accepted by a valid report.
- Missing class denominators yield `null`, never 0% error or 100% recall.

Reports include totals, each numerator/denominator, invalid reports, six per-class
breakdowns, and case IDs. Offline numbers describe fixtures only. Live reports
must separately measure not-checked dimensions, defect localization, new errors
after revision, accepted-task rate, evidence support, conflict handling, producer
and reviewer calls/tokens, actual and unknown costs, p50/p95 latency, recovery, and
cost per accepted report. Unknown usage is not free usage. The current runner does
not fabricate any of these live observations or an adoption decision.

## Frozen A/B/C protocol

A is current Eino; B is Eino plus a fixed independent Reviewer; C is OpenCode plus
that same Reviewer. Freeze the shared user tasks, corpus bytes, model version and
pricing profile, approved Skill content, output contract, review rules, and total
and per-role budgets. Record runtime-specific system prompts, compression, and
context management as part of the runtime intervention; they need not be identical.
Run two separately reported comparisons. `same_producer_budget` gives A six
Producer calls and no Reviewer, and B/C six Producer plus one Reviewer call: total
budgets differ. `equal_total_budget` gives A six Producer calls and B/C five
Producer plus one Reviewer, all with six-call worst-cost caps: role allocations
differ. Enforced review reserves a shorter Producer time window; the driver
records the actual child/final deadlines, frozen conditions and runtime prompts.
Neither comparison may be described as identical in every intervention.
Producer history and tools do not enter the Reviewer context.

First compare B−A independently of OpenCode availability. Compare C−B only after
the fixed OpenCode protocol/isolation probe succeeds. Use blinded paired human
labels and repeated runs; include an equal-total-budget comparison. Freeze a live
evaluation set distinct from the authored fixtures before tuning prompts. Thirty
questions alone do not establish a statistically stable improvement; report
sample counts and uncertainty, and do not claim significance from a single run.

Proposed gates to freeze before live execution:

| Decision | Required observations |
|---|---|
| Safety gates for any enforced Reviewer | Zero hard-error publications; blocking recall >=90%; normal-case false blocks <=10% |
| Adopt B over A | Defective-publication rate reduced >=30% relatively; normal-task acceptance drop <=5 percentage points; cost per accepted report <=1.5 times A; safety gates also pass |
| Adopt C over B | Completion rate increases >=10 percentage points; cost per accepted report <=1.3 times B; safety, isolation, and duplicate-execution gates also pass |

If A publishes zero defects, relative improvement is undefined: add pre-labeled
challenging cases or report no demonstrated improvement, never divide by zero.
Blocking every result cannot pass the normal-acceptance gates. A failed or missing
live measurement is not success. Record `offline_feasible` separately from
`live_accepted`: the former permits only development of a disabled pilot. Keep
Eino/off or shadow when adoption gates are unmet; do not lower gates to favor a
runtime. Human disagreements and untested conditions remain visible.
