import type { AgentSql } from "./agent-transaction.ts";
import { getResearchCandidate } from "./agent-candidates.ts";
import { hashCanonical, validateEvidenceSnapshot } from "./agent-runs.ts";
import { validateCitations } from "./agent-context.ts";
import { validateReviewReport } from "./agent-review.ts";

/** Used by completeRun, so synchronous and asynchronous writers share the same guard. */
export async function researchPublicationError(tx: AgentSql, run: Record<string, any>, response: unknown): Promise<string | null> {
  if (run.mode !== "research" || !run.request_json?.governed) return null;
  const candidate = await getResearchCandidate(tx, run.id);
  if (!candidate) return "candidate_missing";
  const result = response && typeof response === "object" ? (response as Record<string, unknown>).result : undefined;
  if (!result || hashCanonical(result) !== candidate.candidate_digest) return "candidate_mismatch";
  if (hashCanonical(run.request_json.review_policy) !== candidate.policy_digest) return "review_policy_changed";
  if (!validateCitations(candidate.result_json.citations, new Map(candidate.evidence_json.map(row => [row.evidence_id, row]))).ok) return "invalid_citation";
  const current = await validateEvidenceSnapshot(tx, candidate.evidence_json);
  if (!current.ok) return current.error;
  if (candidate.frozen_policy.mode === "off" || candidate.frozen_policy.mode === "shadow") return null;
  if (candidate.frozen_policy.mode !== "enforce") return "review_policy_changed";
  const [review] = await tx.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [run.id]);
  if (!review || review.state !== "completed") return review?.state === "unknown" ? "review_outcome_unknown" : "review_required";
  const checked = validateReviewReport(JSON.stringify(review.report_json), { run_id: run.id, candidate: candidate.result_json, evidence: candidate.evidence_json, policy: candidate.frozen_policy });
  if (!checked.ok) return checked.error;
  if (["candidate_digest", "evidence_digest", "policy_digest"].some(key => review[key] !== candidate[key as keyof typeof candidate])) return "review_binding_mismatch";
  return checked.blocked ? "review_blocked" : null;
}
