import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { agentResultSchema, type AgentResult } from "../agent-contract.ts";
import { agentTransaction, lockRun, ownsRun, type AgentSql } from "./agent-transaction.ts";
import { evidenceMap, validateCitations, type EvidenceReceipt } from "./agent-context.ts";
import { hashCanonical, receiptsForRun, validateEvidenceSnapshot } from "./agent-runs.ts";
import { reviewDigests, validateReviewReport } from "./agent-review.ts";

export const CANDIDATE_MAX_BYTES = 512 * 1024;
export type ResearchCandidate = {
  run_id: string; result_json: AgentResult; evidence_json: EvidenceReceipt[];
  candidate_digest: string; evidence_digest: string; policy_digest: string;
  frozen_policy: Record<string, unknown>;
};
type Failure = { ok: false; error: string };

export async function getResearchCandidate(sql: AgentSql, runId: string): Promise<ResearchCandidate | null> {
  const [row] = await sql.query<ResearchCandidate>("select * from ai_research_candidates where run_id=$1", [runId]);
  return row ?? null;
}

export async function saveResearchCandidate(sql: AgentSql, input: { runId: string; claimToken: string; result: unknown }): Promise<
  { ok: true; candidate: ResearchCandidate; replay: boolean } | Failure
> {
  const parsed = agentResultSchema.safeParse(input.result);
  if (!parsed.success || typeof parsed.data.content !== "string" || !parsed.data.content.trim() || parsed.data.analysis) return { ok: false, error: "invalid_candidate" };
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, input.runId);
    if (locked.run?.mode !== "research" || !await ownsRun(tx, locked, input.claimToken)) return { ok: false, error: "stale" };
    if (locked.job?.payload?.cancel_requested) return { ok: false, error: "cancel_requested" };
    if (locked.run.request_json?.governed) {
      const [calls] = await tx.query<{ n: number }>("select count(*)::int as n from ai_model_calls where run_id=$1 and role='producer' and state!='completed'", [input.runId]);
      if (calls.n) return { ok: false, error: "producer_outcome_unknown" };
    }
    const old = await getResearchCandidate(tx, input.runId);
    if (old) return old.candidate_digest === hashCanonical(parsed.data)
      ? { ok: true, candidate: old, replay: true } : { ok: false, error: "candidate_conflict" };
    const seeds = evidenceMap(locked.run.request_json?.sources ?? []);
    const receipts = await receiptsForRun(tx, input.runId);
    const evidence = [...new Map([...seeds, ...receipts]).values()].sort((a, b) => a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0);
    if (!validateCitations(parsed.data.citations, new Map(evidence.map(e => [e.evidence_id, e]))).ok) return { ok: false, error: "invalid_citation" };
    const policy = locked.run.request_json?.review_policy;
    if (!policy || !["off", "shadow", "enforce"].includes(policy.mode) || policy.question !== locked.run.request_json.question) return { ok: false, error: "review_unconfigured" };
    if (Buffer.byteLength(JSON.stringify({ result: parsed.data, evidence, policy })) > CANDIDATE_MAX_BYTES) return { ok: false, error: "candidate_too_large" };
    // Old receipts are not silently upgraded into evidence for an enforced review.
    const evidenceCheck = await validateEvidenceSnapshot(tx, evidence);
    if (!evidenceCheck.ok) return evidenceCheck;
    if (!await ownsRun(tx, locked, input.claimToken)) return { ok: false, error: "stale" };
    const digests = reviewDigests(parsed.data, evidence, policy);
    await tx.query(`insert into ai_research_candidates(run_id,result_json,evidence_json,candidate_digest,evidence_digest,policy_digest,frozen_policy)
      values($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7::jsonb) on conflict(run_id) do nothing`,
    [input.runId, JSON.stringify(parsed.data), JSON.stringify(evidence), digests.candidate_digest, digests.evidence_digest, digests.policy_digest, JSON.stringify(policy)]);
    const saved = await getResearchCandidate(tx, input.runId);
    if (!saved || saved.candidate_digest !== digests.candidate_digest || saved.evidence_digest !== digests.evidence_digest || saved.policy_digest !== digests.policy_digest) return { ok: false, error: "candidate_conflict" };
    await tx.query(`insert into ai_research_reviews(run_id,candidate_digest,evidence_digest,policy_digest)
      values($1,$2,$3,$4) on conflict(run_id) do nothing`, [input.runId, digests.candidate_digest, digests.evidence_digest, digests.policy_digest]);
    return { ok: true, candidate: saved, replay: false };
  });
}

export type ReviewRequest = {
  schema_version: 1; run_id: string; review_call_id: string; reviewer_grant: string; question: string;
  candidate: AgentResult; evidence: EvidenceReceipt[]; policy: Record<string, unknown>;
  candidate_digest: string; evidence_digest: string; policy_digest: string; request_digest: string; deadline_at: string;
};
export function reviewIntentDigest(request: Omit<ReviewRequest, "reviewer_grant" | "request_digest">): string {
  return hashCanonical({ role: "reviewer", run_id: request.run_id, review_call_id: request.review_call_id,
    question: request.question, candidate_digest: request.candidate_digest, evidence_digest: request.evidence_digest,
    policy_digest: request.policy_digest, model: request.policy.model, policy_version: request.policy.version, deadline_at: request.deadline_at });
}
function reviewerGrant(secret: string, runId: string, claim: string, callId: string, nonce: string) {
  return createHmac("sha256", secret).update(JSON.stringify([runId, claim, callId, nonce])).digest("hex");
}

export async function startResearchReview(sql: AgentSql, input: { runId: string; claimToken: string; grantSecret?: string }): Promise<
  { ok: true; request: ReviewRequest } | Failure
> {
  const secret = input.grantSecret ?? process.env.AGENT_DATA_TOKEN;
  if (!secret) return { ok: false, error: "review_unconfigured" };
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, input.runId);
    if (!await ownsRun(tx, locked, input.claimToken)) return { ok: false, error: "stale" };
    if (locked.job?.payload?.cancel_requested) return { ok: false, error: "cancel_requested" };
    const candidate = await getResearchCandidate(tx, input.runId);
    if (!candidate) return { ok: false, error: "candidate_missing" };
    if (candidate.frozen_policy.mode === "off") return { ok: false, error: "review_not_required" };
    const [review] = await tx.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [input.runId]);
    if (!review || ["completed", "unknown", "failed"].includes(review.state)) return { ok: false, error: "review_" + (review?.state ?? "missing") };
    if (review.claim_token && review.claim_token !== input.claimToken) {
      const calls = await tx.query("select call_id from ai_model_calls where run_id=$1 and call_id=$2", [input.runId, review.review_call_id]);
      if (calls.length) return { ok: false, error: "review_outcome_unknown" };
    }
    const callId = review.review_call_id ?? randomUUID(), nonce = review.grant_nonce ?? randomBytes(24).toString("hex");
    const expires = review.expires_at ?? locked.run.request_json?.review_deadline_at ?? locked.run.expires_at;
    const deadline = new Date(expires).toISOString();
    const [clock] = await tx.query<{ now: Date }>("select clock_timestamp() as now");
    if (Date.parse(deadline) <= new Date(clock.now).getTime()) return { ok: false, error: "review_deadline_exceeded" };
    const grant = reviewerGrant(secret, input.runId, input.claimToken, callId, nonce);
    const request: ReviewRequest = { schema_version: 1, run_id: input.runId, review_call_id: callId, reviewer_grant: grant,
      question: String(candidate.frozen_policy.question), candidate: candidate.result_json, evidence: candidate.evidence_json,
      policy: candidate.frozen_policy, candidate_digest: candidate.candidate_digest, evidence_digest: candidate.evidence_digest,
      policy_digest: candidate.policy_digest, deadline_at: deadline, request_digest: "" };
    request.request_digest = reviewIntentDigest(request);
    if (Buffer.byteLength(JSON.stringify(request)) > CANDIDATE_MAX_BYTES) return { ok: false, error: "review_input_too_large" };
    await tx.query(`update ai_research_reviews set review_call_id=$2,request_digest=$3,grant_nonce=$4,grant_hash=$5,claim_token=$6,expires_at=$7 where run_id=$1`,
      [input.runId, callId, request.request_digest, nonce, createHash("sha256").update(grant).digest("hex"), input.claimToken, deadline]);
    return { ok: true, request };
  });
}

export async function saveResearchReview(sql: AgentSql, input: { runId: string; claimToken: string; report: unknown }): Promise<
  { ok: true; blocked: boolean; replay: boolean } | Failure
> {
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, input.runId);
    if (!await ownsRun(tx, locked, input.claimToken)) return { ok: false, error: "stale" };
    const candidate = await getResearchCandidate(tx, input.runId);
    if (!candidate) return { ok: false, error: "candidate_missing" };
    const validated = validateReviewReport(JSON.stringify(input.report), { run_id: input.runId, candidate: candidate.result_json, evidence: candidate.evidence_json, policy: candidate.frozen_policy });
    if (!validated.ok) return validated;
    const [review] = await tx.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [input.runId]);
    if (!review) return { ok: false, error: "review_missing" };
    if (review.state === "completed") return hashCanonical(review.report_json) === hashCanonical(validated.report)
      ? { ok: true, blocked: validated.blocked, replay: true } : { ok: false, error: "review_conflict" };
    if (review.state !== "running") return { ok: false, error: "review_call_not_completed" };
    const [call] = await tx.query<Record<string, any>>("select * from ai_model_calls where run_id=$1 and call_id=$2", [input.runId, review.review_call_id]);
    if (!call || call.state !== "completed" || call.request_digest !== review.request_digest || call.role !== "reviewer") return { ok: false, error: "review_call_not_completed" };
    await tx.query("update ai_research_reviews set state='completed',report_json=$2::jsonb,grant_hash=null,finished_at=clock_timestamp() where run_id=$1", [input.runId, JSON.stringify(validated.report)]);
    return { ok: true, blocked: validated.blocked, replay: false };
  });
}
