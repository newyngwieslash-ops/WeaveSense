"use client";

import { useAssistant } from "./assistant-provider";

/**
 * Message list renderer (§2.2): plain React text nodes only — no
 * dangerouslySetInnerHTML, no markdown dependency. Role styling separates
 * user / assistant / action_result; stage markers render separately from
 * prose.
 */
export function AssistantMessages() {
  const { state } = useAssistant();
  if (state.messages.length === 0 && state.stages.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted">
        <p>问我任何关于本项目数据的问题，例如：</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>看看最近采集失败的任务</li>
          <li>添加关键词并每 30 分钟采集一次</li>
          <li>根据这些内容深入研究</li>
        </ul>
      </div>
    );
  }
  return (
    <ol className="space-y-3 px-4 py-4" aria-label="对话消息">
      {state.messages.map((message) => (
        <li
          key={message.id}
          className={
            message.role === "user"
              ? "ml-auto max-w-[85%] rounded-md bg-accent/15 px-3 py-2 text-sm text-fg"
              : message.role === "assistant"
                ? "max-w-[95%] rounded-md bg-raised px-3 py-2 text-sm text-fg"
                : "max-w-[95%] rounded-md border border-white/10 px-3 py-2 text-xs text-muted"
          }
        >
          {typeof message.content?.text === "string"
            ? message.content.text.split("\n").map((line, index) => (
              <p key={index} className={index > 0 ? "mt-1" : undefined}>{line}</p>
            ))
            : null}
        </li>
      ))}
      {state.turnActive && (state.stages.length > 0 || state.reasonTail) && (
        <li aria-label="执行进度" className="max-w-[95%] rounded-md bg-raised/60 px-3 py-2">
          {state.stages.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="工具调用">
              {state.stages.map((stage: import("@/lib/assistant-state").StageMarker) => (
                <span
                  key={stage.call_id}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                    stage.state === "running" ? "bg-accent/10 text-fg" : stage.state === "done" ? "bg-raised text-muted" : "bg-danger/15 text-danger"
                  }`}
                >
                  {stage.state === "running" && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />}
                  {stage.tool === "list_keywords" ? "读取关键词"
                    : stage.tool === "list_sources" ? "读取信源"
                    : stage.tool === "search_items" ? "检索内容"
                    : stage.tool === "get_item" ? "读取内容"
                    : stage.tool === "project_overview" ? "读取概览"
                    : stage.tool === "list_notes" ? "读取笔记"
                    : stage.tool === "list_collection_jobs" ? "读取任务"
                    : stage.tool}
                  {stage.state === "done" ? " 完成" : stage.state === "failed" ? " 失败" : ""}
                </span>
              ))}
            </div>
          )}
          {state.reasonTail && (
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer select-none">思维链（最新）</summary>
              <p className="mt-1 whitespace-pre-wrap leading-5">{state.reasonTail}</p>
            </details>
          )}
        </li>
      )}
    </ol>
  );
}
