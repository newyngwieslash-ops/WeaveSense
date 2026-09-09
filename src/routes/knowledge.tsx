import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { coverageCopy, errorCopy, retryOrFreshRequestId } from "@/lib/agent-request";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { askFn, briefingFn, getAskJobFn, listKnowledgeFn } from "@/lib/server/fns";
import { formatRelative } from "@/lib/format";

export const Route = createFileRoute("/knowledge")({
  validateSearch: z.object({ job: z.string().min(1).optional() }),
  component: KnowledgePage,
});

function KnowledgePage() {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/knowledge" });
  const search = useSearch({ from: "/knowledge" });
  const [question, setQuestion] = useState("");
  const [useAsync, setUseAsync] = useState(false);
  const [jobId, setJobId] = useState<string | null>(search.job ?? null);
  const askRequestId = useRef<string | null>(null);
  const briefRequestId = useRef<string | null>(null);
  const data = useQuery({ queryKey: ["knowledge"], queryFn: () => listKnowledgeFn() });
  const asyncEnabled = Boolean((data.data as { capabilities?: { async_research?: boolean } } | undefined)?.capabilities?.async_research);
  const job = useQuery({
    queryKey: ["ask-job", jobId],
    queryFn: () => getAskJobFn({ data: { id: jobId! } }),
    enabled: Boolean(jobId),
    refetchInterval: (q) => {
      const status = q.state.data && "status" in q.state.data ? String(q.state.data.status) : "";
      if (q.state.error || (q.state.data && !q.state.data.ok)) return false;
      if (!jobId || status === "succeeded" || status === "failed" || status === "outcome_unknown") return false;
      return 2_000;
    },
  });
  const ask = useMutation({
    mutationFn: () => {
      askRequestId.current = retryOrFreshRequestId(askRequestId.current, Boolean(askRequestId.current));
      return askFn({ data: { question, request_id: askRequestId.current, async: useAsync && asyncEnabled } });
    },
    onSuccess: (r) => {
      if (r.pending && r.job_id) {
        setJobId(r.job_id);
        void navigate({ search: { job: r.job_id } });
        toast.message("任务已排队，页面会继续查看进度");
        return;
      }
      if (!r.ok) {
        toast.error(errorCopy(r.error_code) + (r.error ? `：${r.error}` : ""));
        setJobId(null);
      } else {
        toast.success("已写入知识库");
        setQuestion("");
        setJobId(null);
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

  const latestAnswer = ask.data?.ok && !ask.data.pending ? ask.data : null;
  const jobStatus = job.data && "status" in job.data ? String(job.data.status) : "";
  const jobError = job.data && !job.data.ok;
  useEffect(() => {
    if (jobStatus === "succeeded") {
      setJobId(null);
      askRequestId.current = null;
      void navigate({ search: { job: undefined } });
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    }
    if (jobStatus === "failed" || jobStatus === "outcome_unknown") {
      askRequestId.current = null;
      setJobId(null);
      void navigate({ search: { job: undefined } });
      toast.error("长任务未完成，可以重新提问。");
    }
    if (jobError) {
      setJobId(null); askRequestId.current = null;
      void navigate({ search: { job: undefined } });
      toast.error("无法找到或读取任务，可以重新提问。");
    }
  }, [jobStatus, jobError, qc, navigate]);

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
        <p className="mt-1 text-sm text-muted">
          只根据已采集条目回答。问题由你发起，不会在页面加载时调用模型。
          {asyncEnabled ? " 长任务已开放，刷新可通过地址栏 job 参数继续查看。" : " 当前为同步问答。"}
        </p>
        <Textarea
          id="q"
          className="mt-3"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：固态电池量产目前卡在哪些环节？"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          {asyncEnabled ? <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={useAsync} onChange={e => setUseAsync(e.target.checked)} />
            后台研究（刷新后继续）
          </label> : <span />}
          <Button type="submit" disabled={ask.isPending || (Boolean(jobId) && jobStatus !== "failed" && jobStatus !== "outcome_unknown") || question.trim().length < 2}>
            {ask.isPending || (jobId && jobStatus !== "failed" && jobStatus !== "outcome_unknown") ? "任务进行中" : "提问"}
          </Button>
        </div>
      </form>

      {jobId ? (
        <p className="mt-3 text-sm text-muted">
          {job.error ? <>暂时无法读取进度，任务地址已保留。<Button variant="outline" size="sm" onClick={() => void job.refetch()}>重试查看</Button></> : jobStatus === "failed" || jobStatus === "outcome_unknown"
            ? errorCopy(jobStatus === "outcome_unknown" ? "run_in_progress" : undefined) + "：长任务未完成。"
            : "任务仍在执行，页面每两秒查看一次，刷新后也会继续。"}
        </p>
      ) : null}

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
              {latestAnswer.external_citations.map((c,i) => (
                <div key={`${c.url}:${i}`}>
                  {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="block text-muted hover:text-fg">{c.title}</a> : <span>{c.title}（服务来源）</span>}
                  <p className="text-muted">{c.quote}</p>
                </div>
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
                {note.citations?.length ? <div className="mt-4 space-y-2 text-sm text-muted">{note.citations.map(c => <blockquote key={c.evidence_id} className="border-l-2 border-border pl-3">
                  <p>{c.quote}</p>
                  {c.item_id ? <Link to="/inbox/$itemId" params={{itemId:c.item_id}}>{c.title}</Link>
                    : c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : <span>{c.title}</span>}
                </blockquote>)}</div> : null}
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
