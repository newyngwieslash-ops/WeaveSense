"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAssistant } from "./assistant-provider";
import { decideAction } from "@/lib/assistant-client";
import { effectsForReceipt } from "@/lib/assistant-effects";
import type { ActionReceiptPublic } from "@/lib/server/assistant-action-receipt";

/**
 * Action card (§2.2/§6.1): shows the frozen host preview, the digest-bound
 * decision buttons, and the persisted receipt once decided. Double-approve
 * is disabled by request-id state; a network failure keeps the card so the
 * user can retry the same decision (the request id replays server-side).
 */
export function AssistantActionCard(props: {
  actionId: string;
  kind: string;
  previewText: string;
  previewDigest: string;
  expiresAt: string | null;
  decided?: "approve" | "reject";
  receipt?: ActionReceiptPublic;
  requestId: string;
}) {
  const qc = useQueryClient();
  const { state, refresh } = useAssistant();
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<"approve" | "reject" | null>(props.decided ?? null);
  const [receipt, setReceipt] = useState<ActionReceiptPublic | null>(props.receipt ?? null);
  const [error, setError] = useState<string | null>(null);

  const kindLabel: Record<string, string> = {
    "keyword.create": "新建关键词",
    "keyword.update": "更新关键词",
    "keyword.set_enabled": "启停关键词",
    "keyword.collect_once": "关键词采集",
    "source.create": "新增 RSS 信源",
    "source.set_enabled": "启停信源",
    "source.collect_once": "信源采集",
    "research.start": "深入研究",
    "research.cancel": "取消研究",
  };

  const expired = props.expiresAt != null && Date.parse(props.expiresAt) <= Date.now();

  const decide = async (decision: "approve" | "reject") => {
    if (busy || decided) return;
    setBusy(true);
    setError(null);
    try {
      const result = await decideAction(
        props.actionId,
        props.requestId,
        decision,
        props.previewDigest,
        state.conversation?.revision ?? 0,
      ) as unknown as ActionReceiptPublic;
      setDecided(decision);
      setReceipt(result);
      // Fixed domain → key mapping only (§6.1.7); the model supplies nothing.
      for (const key of effectsForReceipt(result)) {
        void qc.invalidateQueries({ queryKey: key });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error && e.message === "conflict" ? "操作已冲突：预览过期或状态已变化" : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-white/15 bg-raised p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{kindLabel[props.kind] ?? props.kind}</span>
        {props.expiresAt && !decided && (
          <span className="text-xs text-muted">{expired ? "已过期" : "等待确认"}</span>
        )}
      </div>
      <p className="mt-1 text-fg">{props.previewText}</p>
      {receipt && (
        <p className="mt-2 text-xs text-muted">
          {receipt.status === "succeeded" && receipt.effect === "created" && "已创建"}
          {receipt.status === "succeeded" && receipt.effect === "existing" && "已存在同名配置，未修改"}
          {receipt.status === "succeeded" && receipt.effect === "unchanged" && "配置未变化"}
          {receipt.status === "succeeded" && receipt.effect === "skipped" && "已跳过"}
          {receipt.status === "rejected" && "已拒绝"}
          {receipt.status === "failed" && `执行失败${receipt.error_code ? `（${receipt.error_code}）` : ""}`}
          {receipt.status === "conflict" && "冲突：目标已变化，未执行"}
          {receipt.counts && receipt.counts.inserted > 0 ? `，新增 ${receipt.counts.inserted} 条` : ""}
          {receipt.partial_effects_possible ? "；可能已有部分写入" : ""}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      {!decided && !expired && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void decide("approve")} disabled={busy}>
            {busy ? "执行中…" : "确认执行"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void decide("reject")} disabled={busy}>
            拒绝
          </Button>
        </div>
      )}
      {expired && !decided && (
        <p className="mt-2 text-xs text-muted">预览已过期，请让助手重新生成。</p>
      )}
    </div>
  );
}
