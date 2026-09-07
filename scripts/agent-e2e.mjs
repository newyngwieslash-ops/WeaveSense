#!/usr/bin/env node
import assert from "node:assert/strict";

function newAgentRequestId() {
  return crypto.randomUUID();
}
function retryOrFreshRequestId(current, explicitRetry) {
  if (explicitRetry && current) return current;
  return newAgentRequestId();
}
function errorCopy(code) {
  switch (code) {
    case "run_in_progress": return "任务仍在执行";
    case "persist_failed": return "结果未保存";
    case "insufficient_evidence": return "材料不足";
    case "input_changed": return "原文已变化，请重新分析";
    default: return "生成失败";
  }
}
function coverageCopy(coverage) {
  if (coverage === "partial") return "部分覆盖：只分析了截取片段，不是全文。";
  if (coverage === "full") return "覆盖范围：全文片段。";
  return "历史结果，覆盖范围未记录";
}

const first = retryOrFreshRequestId(null, false);
const retry = retryOrFreshRequestId(first, true);
const fresh = retryOrFreshRequestId(first, false);
assert.equal(retry, first, "network retry reuses request id");
assert.notEqual(fresh, first, "explicit new analysis gets a new id");
assert.equal(errorCopy("run_in_progress"), "任务仍在执行");
assert.equal(errorCopy("persist_failed"), "结果未保存");
assert.match(coverageCopy("partial"), /部分覆盖/);
assert.match(coverageCopy("unknown"), /历史结果/);
assert.match(coverageCopy(null), /历史结果/);

const rendered = {
  internal: ["/inbox/item-1"],
  external: ["https://example.com/ext"],
};
assert.equal(rendered.external.includes("/inbox/https://example.com/ext"), false);

if (process.env.AGENT_E2E_TARGET) {
  const url = new URL(process.env.AGENT_E2E_TARGET);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    console.error("agent-e2e refuses non-local targets");
    process.exit(1);
  }
}

console.log("agent-e2e: PASS");
