# OpenCode adoption decision

Date: 2026-10-07. Scope: approved corpus research only.

**offline_feasible: true. live_accepted: false. Production enablement remains off.**

The locked OpenCode 1.3.13 binary ran against authored local model and MCP fixtures.
The Docker Linux runtime used a fresh task directory/HOME/XDG, default-deny tools,
the approved Skill bytes, and no real supplier credentials. The recorded isolation
tests confirmed process-tree termination, stale-epoch refusal, task-history isolation,
and rejected public, link-local and numeric host connections. A control container
could reach the same active host canary, so DNS failure alone was not counted as
network isolation. See `runtime-lock.json`, `isolation.fixture.json` and
`isolation.test.mjs` for the exact platform, artifact hashes and repeatable checks.

These observations justify implementing a disabled optional executor. They do not
demonstrate answer-quality, latency or financial improvement. Docker Desktop results
must be repeated on the deployment host before live enablement. The native runtime
to trusted Go model proxy integration and the complete host ledger chain have their
own tests; a fake success is never substituted for either of those checks.

The independently useful Eino changes remain the first delivery: consistent deadlines,
immutable Skill snapshots, role budgets, saved candidates, independent review and a
host-controlled atomic publication boundary. They do not depend on adopting OpenCode.

The acceptance rules remain those preregistered in `quality-policy.md` and the
implementation plan. A/B/C must use the same priced model, corpus versions, questions,
limits and blind evaluation. The live runner requires an explicit finite budget and
the trusted accounting/isolation chain; missing results stay missing. Do not enable
enforced semantic review or declare OpenCode superior from authored fixtures, longer
answers, self-scores, protocol coverage, or the existence of another runtime.

Current decision: integration checks have passed with local fake suppliers;
retain the bounded, reversible pilot in its disabled state. Revisit production
adoption only after real B−A and C−B evidence meets the
frozen quality/cost gates. If C fails, retain the Eino improvements and leave OpenCode
disabled; do not rename a failed quality experiment as a maintenance win.
