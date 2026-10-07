import { reviewBlocks, reviewReportSchema, type ReviewReport } from "../agent-review-contract.ts";
import type { AgentResult } from "../agent-contract.ts";
import type { EvidenceReceipt } from "./agent-context.ts";
import { hashCanonical } from "./agent-runs.ts";

export const REVIEW_REPORT_MAX_BYTES = 128 * 1024;
export type ReviewContext = {
  run_id: string;
  candidate: AgentResult;
  evidence: readonly EvidenceReceipt[];
  policy: Record<string, unknown>;
};

export function reviewDigests(candidate: AgentResult, evidence: readonly EvidenceReceipt[], policy: Record<string, unknown>) {
  if (new Set(evidence.map(row => row.evidence_id)).size !== evidence.length) throw new Error("duplicate_evidence_id");
  const ordered = [...evidence].sort((a, b) => a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0);
  return {
    candidate_digest: hashCanonical(candidate),
    evidence_digest: hashCanonical(ordered),
    policy_digest: hashCanonical(policy),
  };
}

export type ReviewValidation =
  | { ok: true; report: ReviewReport; blocked: boolean; digests: ReturnType<typeof reviewDigests> }
  | { ok: false; error: string };

// This validates a report as data; it does not grant publication or execute its text.
// The caller must supply the stored snapshot, then check its version again at publication.
export function validateReviewReport(raw: string, context: ReviewContext): ReviewValidation {
  if (typeof raw !== "string") return { ok: false, error: "invalid_review_json" };
  if (Buffer.byteLength(raw, "utf8") > REVIEW_REPORT_MAX_BYTES) return { ok: false, error: "review_too_large" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: "invalid_review_json" }; }
  const parsed = reviewReportSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "invalid_review_report" };
  let digests: ReturnType<typeof reviewDigests>;
  try { digests = reviewDigests(context.candidate, context.evidence, context.policy); }
  catch { return { ok: false, error: "invalid_review_context" }; }
  const report = parsed.data;
  if (report.run_id !== context.run_id ||
    report.candidate_digest !== digests.candidate_digest ||
    report.evidence_digest !== digests.evidence_digest ||
    report.policy_digest !== digests.policy_digest) return { ok: false, error: "review_binding_mismatch" };

  const evidenceIds = new Set(context.evidence.map(row => row.evidence_id));
  const candidateTexts = [context.candidate.content, context.candidate.title].filter((text): text is string => typeof text === "string");
  for (const finding of report.findings) {
    if (!candidateTexts.some(text => text.includes(finding.claim))) return { ok: false, error: "invalid_review_claim" };
    if (finding.evidence_ids.some(id => !evidenceIds.has(id)) ||
      new Set(finding.evidence_ids).size !== finding.evidence_ids.length ||
      (finding.evidence_ids.length === 0 && finding.code !== "insufficient_evidence")) return { ok: false, error: "invalid_review_evidence" };
    if (/<\/?(?:tool(?:_call)?|function_call|execute|command|script|system)\b/i.test(JSON.stringify(finding))) {
      return { ok: false, error: "invalid_review_instructions" };
    }
  }
  return { ok: true, report, blocked: reviewBlocks(report), digests };
}
