import { z } from "zod";

export const reviewCheckIds = ["support", "scope", "conflicts", "source_independence", "uncertainty"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().min(1).max(max).refine(v => v.trim().length > 0, "empty_review_text");

export const reviewReportSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  candidate_digest: digest,
  evidence_digest: digest,
  policy_digest: digest,
  checks: z.array(z.object({
    id: z.enum(reviewCheckIds),
    status: z.enum(["pass", "fail", "not_checked"]),
  }).strict()).length(reviewCheckIds.length),
  findings: z.array(z.object({
    code: text(64),
    severity: z.enum(["blocking", "advisory"]),
    claim: text(1000),
    evidence_ids: z.array(text(128)).max(20),
    reason: text(2000),
    suggestion: text(1000),
  }).strict()).max(20),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(check => check.id)).size !== reviewCheckIds.length) {
    ctx.addIssue({ code: "custom", message: "duplicate_review_check" });
  }
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;

export function reviewBlocks(report: ReviewReport): boolean {
  return report.checks.some(check => check.status !== "pass") ||
    report.findings.some(finding => finding.severity === "blocking");
}
