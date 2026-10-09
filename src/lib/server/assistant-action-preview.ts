/**
 * Host-side action preview (plan Task 11 / §6.1).
 *
 * The host — never the model — renders the human-readable Chinese preview and
 * computes the canonical digest that the decision API must echo back. The
 * digest binds action identity, kind, args, the observed config snapshot, the
 * policy version and the expiry; a changed target invalidates the digest
 * (A11) before anything executes.
 */
import { createHash } from "node:crypto";
import { ASSISTANT_SCHEMA_VERSION } from "../assistant-contract.ts";
import type { AssistantAction } from "../assistant-contract.ts";

export const ASSISTANT_POLICY_VERSION = "loom-assistant-v1";

export type ActionPreviewSnapshot = {
  interval?: number;
  platforms?: string[];
  enabled?: boolean;
} | null;

export type ActionPreview = {
  text: string;
  digest: string;
  expected: ActionPreviewSnapshot;
};

const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function describeAction(action: AssistantAction, snapshot: ActionPreviewSnapshot): string {
  const a = action.args as Record<string, unknown>;
  switch (action.kind) {
    case "keyword.create": {
      const platforms = (a.platforms as string[] | undefined)?.join("、") ?? "";
      return `新建关键词「${String(a.keyword)}」：平台 ${platforms}，每 ${String(a.interval)} 分钟采集${a.enabled ? "，创建后启用" : "，保持停用"}。`;
    }
    case "keyword.update": {
      const parts: string[] = [];
      if (a.interval !== undefined) parts.push(`采集间隔 ${snapshot?.interval ?? "（当前）"} → ${String(a.interval)} 分钟`);
      if (a.platforms !== undefined) parts.push(`平台 ${snapshot?.platforms?.join("、") ?? "（当前）"} → ${(a.platforms as string[]).join("、")}`);
      return `更新关键词「${String(a.keyword_id)}」：${parts.join("；")}。`;
    }
    case "keyword.set_enabled": {
      return `${a.enabled ? "启用" : "停用"}关键词「${String(a.keyword_id)}」${a.enabled ? "；启用后将按当前间隔参与定时采集" : ""}。`;
    }
    case "source.create": {
      return `新增 RSS 信源「${String(a.url)}」${a.enabled ? "，创建后启用" : "，默认停用"}。`;
    }
    case "source.set_enabled": {
      return `${a.enabled ? "启用" : "停用"}信源「${String(a.source_id)}」${a.enabled ? "；启用后将按当前间隔参与定时采集" : ""}。`;
    }
    case "keyword.collect_once":
      return `对关键词「${a.keyword_id ?? "（前项创建）"}」立即发起一次采集：将发出外部检索请求，可能消耗供应商配额（非模型费用）。`;
    case "source.collect_once":
      return `对信源「${a.source_id ?? "（前项创建）"}」立即发起一次采集：将发出外部请求，可能消耗供应商配额（非模型费用）。`;
    case "research.start":
      return `以「${String(a.question)}」为题发起深入研究：独立子任务预算，结果需经审核后才会发布为知识笔记。`;
    case "research.cancel":
      return `取消关联的研究任务「${String(a.job_id)}」：已完成的写入不会回滚。`;
    case "item.analyze":
      return `对条目「${String(a.item_id)}」发起单篇专业分析：消耗独立分析预算，结果需在详情页按本次 ID 查看。`;
    case "knowledge.briefing":
      return "生成行业简报：汇总时间范围内最近条目（上限 12 条），经审核后保存为知识笔记。";
  }
}

/**
 * Build the preview for one action against the observed config snapshot.
 * Pure: no IO, no model, no DB. The snapshot is read by the caller inside
 * the propose transaction.
 */
export function buildActionPreview(action: AssistantAction, snapshot: ActionPreviewSnapshot, actionId: string, expiresAt?: string): ActionPreview {
  const digestInput = {
    action_id: actionId,
    kind: action.kind,
    args: action.args,
    expected_state: snapshot,
    policy_version: ASSISTANT_POLICY_VERSION,
    schema_version: ASSISTANT_SCHEMA_VERSION,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
  return {
    text: describeAction(action, snapshot),
    digest: digestOf(digestInput),
    expected: snapshot,
  };
}
