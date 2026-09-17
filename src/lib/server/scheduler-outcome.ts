import type { KeywordAttempt } from "./collectors/types.ts";

/**
 * T08: decide how a keyword run should be recorded.
 *
 * Kept as a pure function so the three cases the old code conflated are directly
 * testable:
 *   - no external source was asked (a local-only scope) -> a normal local run;
 *   - every external source failed -> `error`, even though local tags may exist;
 *   - some failed -> `ok`, with the failing sources named in the note.
 *
 * Only stable error codes reach the note. Raw provider messages are deliberately
 * not included: they can embed the query string or a token.
 */
export function keywordRunOutcome(
  attempts: KeywordAttempt[],
  counts: { externalItems: number; localTagged: number },
): { status: "ok" | "error"; note: string } {
  const failed = attempts.filter((a) => a.status === "error");
  const allFailed = attempts.length > 0 && failed.length === attempts.length;
  const failedSources = failed.map((a) => a.source).join("、");
  const codes = [...new Set(failed.map((a) => a.error_code ?? "network_error"))].join("/");
  const local = counts.localTagged > 0 ? `，本地命中 ${counts.localTagged} 条` : "";

  if (allFailed) {
    return { status: "error", note: `外部检索全部失败（${failedSources}：${codes}）${local}` };
  }
  if (failed.length) {
    return { status: "ok", note: `部分来源失败（${failedSources}：${codes}）${local}` };
  }
  if (counts.externalItems === 0 && counts.localTagged === 0 && attempts.length > 0) {
    return { status: "ok", note: "检索源暂无新结果，已扫描本地库" };
  }
  if (counts.externalItems === 0 && counts.localTagged > 0) {
    return { status: "ok", note: `外部无新结果，本地命中 ${counts.localTagged} 条` };
  }
  return { status: "ok", note: "" };
}
