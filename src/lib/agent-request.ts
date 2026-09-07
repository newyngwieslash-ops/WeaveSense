export function newAgentRequestId(): string {
  return crypto.randomUUID();
}

export function retryOrFreshRequestId(current: string | null, explicitRetry: boolean): string {
  if (explicitRetry && current) return current;
  return newAgentRequestId();
}

export function errorCopy(code?: string): string {
  switch (code) {
    case "run_in_progress": return "任务仍在执行";
    case "queued": return "任务已排队，刷新后继续查看";
    case "persist_failed": return "结果未保存";
    case "insufficient_evidence": return "材料不足";
    case "input_changed": return "原文已变化，请重新分析";
    default: return "生成失败";
  }
}

export function coverageCopy(coverage?: "full" | "partial" | "unknown" | null): string {
  if (coverage === "partial") return "部分覆盖：只分析了截取片段，不是全文。";
  if (coverage === "full") return "覆盖范围：全文片段。";
  return "历史结果，覆盖范围未记录";
}
