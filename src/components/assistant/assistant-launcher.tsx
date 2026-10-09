"use client";

import { Button } from "@/components/ui/button";
import { useAssistant } from "./assistant-provider";

/**
 * Launcher (plan §2.2): the fixed bottom-right entry. Shows a running dot
 * while a turn is active — even when the panel is closed — so a hidden task
 * stays visible. Touch target ≥44px, never covers the mobile bottom bar
 * (sits above it via bottom offset).
 */
export function AssistantLauncher() {
  const { state, openPanel } = useAssistant();
  if (state.panelOpen) return null;
  return (
    <button
      type="button"
      onClick={openPanel}
      aria-label="打开织识助手"
      className="fixed right-4 bottom-20 lg:bottom-6 z-40 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-raised px-4 py-2 text-sm text-fg shadow-lg hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <span aria-hidden className="text-base">🧭</span>
      <span>织识助手</span>
      {state.turnActive && (
        <span aria-label="任务运行中" className="size-2 animate-pulse rounded-full bg-accent" />
      )}
    </button>
  );
}
