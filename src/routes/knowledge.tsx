import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { coverageCopy, errorCopy, retryOrFreshRequestId } from "@/lib/agent-request";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { askFn, briefingFn, listKnowledgeFn } from "@/lib/server/fns";
import { formatRelative } from "@/lib/format";

export const Route = createFileRoute("/knowledge")({ component: KnowledgePage });

function KnowledgePage() {
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const askRequestId = useRef<string | null>(null);
  const briefRequestId = useRef<string | null>(null);
  const data = useQuery({ queryKey: ["knowledge"], queryFn: () => listKnowledgeFn() });
  const ask = useMutation({
    mutationFn: () => {
      askRequestId.current = retryOrFreshRequestId(askRequestId.current, Boolean(askRequestId.current));
      return askFn({ data: { question, request_id: askRequestId.current } });
    },
    onSuccess: (r) => {
      if (!r.ok) toast.error(errorCopy(r.error_code) + (r.error ? `：${r.error}` : ""));
      else {
        toast.success("已写入知识库");
        setQuestion("");
      }
      askRequestId.current = null;
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
  const brief = useMutation({
    mutationFn: () => {
      briefRequestId.current = retryOrFreshRequestId(briefRequestId.current, Boolean(briefRequestId.current));
      return briefingFn({ data: { request_id: briefRequestId.current } });
    },
    onSuccess: (r) => {
      if (!r.ok) toast.error(errorCopy("error_code" in r ? String(r.error_code ?? "") : "") + (r.error ? `：${r.error}` : ""));
      else toast.success(r.title ?? "简报已生成");
      briefRequestId.current = null;
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const latestAnswer = ask.data?.ok ? ask.data : null;

  return (
    <AppShell
      title="知识库"
      kicker="RAG · Briefing"
      action={
        <Button size="sm" variant="outline" onClick={() => brief.mutate()} disabled={brief.isPending}>
          {brief.isPending ? "正在编报" : "生成今日简报"}
        </Button>
      }
    >
      <form
        className="rounded-lg bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          ask.mutate();
        }}
      >
        <label className="font-display text-xl tracking-tight" htmlFor="q">
          向矩阵提问
        </label>
        <p className="mt-1 text-sm text-muted">只根据已采集条目回答。问题由你发起，不会在页面加载时调用模型。</p>
        <Textarea
          id="q"
          className="mt-3"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：固态电池量产目前卡在哪些环节？"
        />
        <div className="mt-3 flex justify-end">
          <Button type="submit" disabled={ask.isPending || question.trim().length < 2}>
            {ask.isPending ? "检索中" : "提问"}
          </Button>
        </div>
      </form>

      {latestAnswer?.answer ? (
        <article className="mt-5 rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">本次回答</p>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{latestAnswer.answer}</div>
          {latestAnswer.insufficient_evidence ? (
            <p className="mt-3 text-sm text-muted">材料不足，没有编造引用。</p>
          ) : null}
          {latestAnswer.citations?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {latestAnswer.citations.map((c) => (
                <Link key={c.id} to="/inbox/$itemId" params={{ itemId: c.id }}>
                  <Badge>{c.title}</Badge>
                </Link>
              ))}
            </div>
          ) : null}
          {latestAnswer.external_citations?.length ? (
            <div className="mt-3 space-y-1 text-sm">
              {latestAnswer.external_citations.map((c) => (
                <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="block text-muted hover:text-fg">
                  {c.title}
                </a>
              ))}
            </div>
          ) : null}
        </article>
      ) : null}

      <section className="mt-8">
        <h2 className="font-display text-xl tracking-tight">简报与笔记</h2>
        <div className="mt-3 space-y-3">
          {(data.data?.notes ?? []).length === 0 ? (
            <p className="text-sm text-muted">生成简报或提问后，会沉淀在这里。</p>
          ) : (
            data.data?.notes.map((note) => (
              <article key={note.id} className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={note.kind === "briefing" ? "live" : "muted"}>
                    {note.kind === "briefing" ? "简报" : note.kind === "answer" ? "问答" : "笔记"}
                  </Badge>
                  <span className="font-mono text-[11px] text-faint">{formatRelative(note.created_at)}</span>
                </div>
                <h3 className="mt-2 font-display text-lg">{note.title}</h3>
                <p className="mt-1 text-xs text-muted">{coverageCopy(note.coverage)}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{note.content}</p>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-xl tracking-tight">条目分析</h2>
        <div className="mt-3 divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
          {(data.data?.analyses ?? []).length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted">在内容详情页触发 LLM 分析。</p>
          ) : (
            data.data?.analyses.map((a) => (
              <Link
                key={a.id}
                to="/inbox/$itemId"
                params={{ itemId: a.item_id }}
                className="block px-4 py-4 hover:bg-raised/60"
              >
                <p className="text-sm">{a.item_title}</p>
                <p className="mt-1 text-xs text-muted">{a.summary}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.topics.slice(0, 4).map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
