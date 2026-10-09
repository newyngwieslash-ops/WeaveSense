"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { useAssistant } from "./assistant-provider";

/**
 * Composer (§2.2): Enter sends, Shift+Enter inserts a newline, IME
 * composition never submits, busy state keeps the draft. The active page
 * reference is attached per send ("仅本次发送引用当前页面").
 */
export function AssistantComposer({ page }: { page: string }) {
  const { state, send } = useAssistant();
  const [draft, setDraft] = useState("");
  const composingRef = useRef(false);

  const submit = async () => {
    const text = draft.trim();
    if (!text || state.sending || state.turnActive) return;
    setDraft("");
    await send(text, page, []);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
      event.preventDefault();
      void submit();
    }
  };

  const disabled = state.sending || state.turnActive || !state.conversationId;

  return (
    <div className="border-t border-white/10 bg-bg p-3">
      {state.composerError && (
        <p className="mb-2 text-xs text-danger" role="alert">
          {state.composerError === "conflict" || state.composerError === "revision_or_active_conflict"
            ? "已有正在进行的对话轮次，请稍候或刷新"
            : state.composerError === "request_conflict"
              ? "请求内容冲突，请重新输入"
              : state.composerError === "assistant_unavailable"
                ? "助手执行器未就绪：需配置 Worker（AGENT_OPENCODE_WORKER_ENABLED + OPENCODE_WORKER_TOKEN）。模型设置页的档案不直接作为助手引擎（见 docs/operations/project-assistant.md §7.1）"
                : "发送失败，请稍后重试"}
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          rows={2}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          aria-label="助手输入框"
          disabled={!state.conversationId}
          className="min-h-11 flex-1 resize-none rounded-sm border border-white/15 bg-raised px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
        />
        <Button type="button" size="sm" onClick={() => void submit()} disabled={disabled || draft.trim().length === 0}>
          发送
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">仅本次发送引用当前页面：{page}</p>
    </div>
  );
}
