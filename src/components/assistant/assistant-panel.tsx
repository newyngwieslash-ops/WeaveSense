"use client";

import { useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useAssistant } from "./assistant-provider";
import { AssistantComposer } from "./assistant-composer";
import { AssistantMessages } from "./assistant-message";
import { AssistantActionCard } from "./assistant-action-card";

/**
 * Panel (§2.2): right-side dock ≥1280px, overlay below that, Radix-free
 * (fixed positioning + backdrop) to avoid a second focus system on mobile.
 * Header carries status, new conversation, close; body carries the running
 * turn indicator and messages; footer carries the composer.
 */
const PAGE_LABELS: Array<[RegExp, string]> = [
  [/^\/$/, "overview"],
  [/^\/keywords/, "keywords"],
  [/^\/sources/, "sources"],
  [/^\/inbox\/.+/, "item"],
  [/^\/inbox/, "inbox"],
  [/^\/knowledge/, "knowledge"],
  [/^\/jobs/, "jobs"],
  [/^\/nodes/, "nodes"],
  [/^\/model-settings/, "model-settings"],
  [/^\/pipeline/, "pipeline"],
  [/^\/guide/, "guide"],
  [/^\/prd/, "prd"],
];

function pageOf(pathname: string): string {
  for (const [pattern, page] of PAGE_LABELS) {
    if (pattern.test(pathname)) return page;
  }
  return "overview";
}

const REASON_TEXT: Record<string, string> = {
  assistant_disabled: "助手未启用：需在服务端配置 AGENT_ASSISTANT_ENABLED",
  model_config_missing: "助手不可用：未配置模型服务（本机访问限定）",
  research_governance_unconfigured: "助手不可用：研究模型定价或规则快照尚未配置",
};

export function AssistantPanel() {
  const { state, capabilities, closePanel, startNewConversation } = useAssistant();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // One stable decision-request id per panel mount: every decision from this
  // panel session shares it, so a repeated decision replays server-side.
  // http:// LAN hosts are not a secure context, so crypto.randomUUID may be
  // absent; fall back to random hex shaped as a UUID (uniqueness within the
  // panel session is all the decision id needs).
  const decisionRequestIdRef = useRef(
    globalThis.crypto?.randomUUID?.() ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0"))
      .join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
  );
  const decisionRequestId = decisionRequestIdRef.current;
  if (!state.panelOpen) return null;
  const disabledReason = capabilities && !capabilities.enabled ? REASON_TEXT[capabilities.reason ?? ""] ?? "助手暂不可用" : null;
  return (
    <>
      <button
        type="button"
        aria-label="关闭助手面板"
        onClick={closePanel}
        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
      />
      <aside
        role="complementary"
        aria-label="织识助手"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[50dvh] flex-col border-t border-white/15 bg-bg shadow-2xl lg:inset-y-0 lg:right-0 lg:left-auto lg:h-auto lg:w-[420px] lg:border-l lg:border-t-0"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-base">🧭</span>
            <span className="text-sm font-medium text-fg">织识助手</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                state.turnActive ? "bg-accent/15 text-fg" : disabledReason ? "bg-danger/15 text-danger" : "bg-raised text-muted"
              }`}
            >
              {state.turnActive ? "任务运行中" : disabledReason ? "不可用" : "就绪"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void startNewConversation()} disabled={state.turnActive}>
              新对话
            </Button>
            <Button variant="ghost" size="sm" onClick={closePanel} aria-label="收起">
              收起
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {disabledReason ? (
            <p className="px-4 py-6 text-sm text-muted">{disabledReason}</p>
          ) : (
            <>
              <AssistantMessages />
              {state.proposals.length > 0 && (
                <div className="space-y-3 px-4 pb-4" aria-label="待确认操作">
                  {state.proposals.map((proposal) => (
                    <AssistantActionCard
                      key={proposal.action_id}
                      actionId={proposal.action_id}
                      kind={proposal.kind}
                      previewText={proposal.preview_text ?? "等待预览内容"}
                      previewDigest={proposal.preview_digest ?? ""}
                      expiresAt={proposal.expires_at ?? null}
                      requestId={decisionRequestId}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {disabledReason ? null : <AssistantComposer page={pageOf(pathname)} />}
      </aside>
    </>
  );
}
