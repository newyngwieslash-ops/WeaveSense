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
import { askFn, briefingFn, getAskJobFn, cancelAskJobFn, listKnowledgeFn } from "@/lib/server/fns";
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
  const observedTerminal = useRef<string | null>(null);
  const data = useQuery({ queryKey: ["knowledge"], queryFn: () => listKnowledgeFn() });
  const asyncEnabled = Boolean((data.data as { capabilities?: { async_research?: boolean } } | undefined)?.capabilities?.async_research);
  const job = useQuery({
    queryKey: ["ask-job", jobId],
    queryFn: () => getAskJobFn({ data: { id: jobId! } }),
    enabled: Boolean(jobId),
    refetchInterval: (q) => {
      if (q.state.error || (q.state.data && !q.state.data.ok)) return false;
      if (!jobId || (q.state.data?.ok && q.state.data.terminal)) return false;
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
      void navigate({ search: { job: undefined } });
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelAskJobFn({ data: { id: jobId! } }),
    onSuccess: (r) => {
      if (!r.ok) toast.error(r.error_code === "trusted_access_required" ? "取消任务需要已配置的可信本机访问。" : "暂时无法取消任务，请重试查看进度。");
      else {
        qc.setQueryData(["ask-job", jobId], r);
        toast.message(r.phase === "cancel_requested" ? "取消请求已提交，正在等待执行器确认停止。" : r.error_code === "cancelled" ? "排队任务已取消。" : "任务已结束，状态已更新。");
      }
    },
    onError: () => toast.error("取消请求未确认，请重新查看任务状态。"),
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
  const research = job.data?.ok ? job.data : null;
  const jobActive = Boolean(jobId) && (!job.data || Boolean(research && !research.terminal));
  useEffect(() => {
    if (research?.terminal && observedTerminal.current !== research.job_id) {
      observedTerminal.current = research.job_id;
      askRequestId.current = null;
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    }
  }, [research, qc]);

  const phaseText = { queued: "已排队", researching: "正在研究", reviewing: "正在审核", published: "已发布",
    blocked: research?.error_code === "cancelled" ? "已取消排队任务" : "未发布", outcome_unknown: "结果待核实", cancel_requested: "正在请求取消" };
  const checkNames: Record<string, string> = { support: "引用支撑", scope: "范围与覆盖", conflicts: "材料冲突", source_independence: "信源独立性", uncertainty: "不确定性" };

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
          {asyncEnabled ? " 深入研究支持刷新后继续查看进度。" : " 深入研究仅在已配置的可信本机环境和执行服务中开放；目前可用普通问答。"}
        </p>
        <Textarea
          id="q"
          className="mt-3"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：固态电池量产目前卡在哪些环节？"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="问答方式">
            <Button type="button" variant={!useAsync ? "primary" : "outline"} aria-pressed={!useAsync} disabled={ask.isPending || jobActive} onClick={() => setUseAsync(false)}>普通问答</Button>
            <Button type="button" variant={useAsync ? "primary" : "outline"} aria-pressed={useAsync} disabled={!asyncEnabled || ask.isPending || jobActive} onClick={() => setUseAsync(true)}>深入研究</Button>
          </div>
          <Button type="submit" disabled={ask.isPending || jobActive || question.trim().length < 2}>
            {ask.isPending || jobActive ? "任务进行中" : "提问"}
          </Button>
        </div>
      </form>

      {jobId ? (
        <section className="mt-5 rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]" aria-label="深入研究进度">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg" role="status">{research ? phaseText[research.phase] : "读取研究进度"}</h2>
            {research?.can_cancel ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "提交取消请求" : "取消研究"}</Button> : null}
          </div>
          {job.error || job.isPaused ? <p className="mt-2 text-sm text-muted">暂时无法读取进度，任务地址已保留。<Button variant="outline" size="sm" onClick={() => void job.refetch()}>重试查看</Button></p> : null}
          {job.data && !job.data.ok ? <p className="mt-2 text-sm text-muted">{job.data.error_code === "trusted_access_required" ? "读取研究草稿需要已配置的可信本机访问。普通问答仍可使用。" : "未找到该研究任务，任务地址已保留。"}</p> : null}
          {research ? <>
            <p className="mt-2 text-sm text-muted">{research.review_mode === "off" ? "本任务未启用独立审核。" : research.review_mode === "shadow" ? "审核仅用于观察，不作为发布依据。" : "按本任务冻结的规则审核；草稿不等于已发布。"}</p>
            {research.phase === "cancel_requested" ? <p className="mt-2 text-sm text-muted">已撤销后续调用权限，正在等待执行器确认停止；已发出的调用仍可能产生费用。</p> : null}
            {research.phase === "outcome_unknown" ? <p className="mt-2 text-sm text-muted">执行或审核结果尚未确认，未据此发布；请勿假定重试不会重复产生费用。</p> : null}
            {research.phase === "blocked" && research.error_code !== "cancelled" ? <p className="mt-2 text-sm text-muted">研究未能发布。下方保留已有草稿与审核发现，新提问会开始另一次执行。</p> : null}
            {research.candidate ? <div className="mt-4">
              <h3 className="font-display text-base">{research.phase === "published" ? "已发布回答" : "研究草稿（尚未发布）"}</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{research.candidate.content}</p>
              {research.candidate.citations.map((c, i) => <blockquote key={`${c.evidence_id}:${i}`} className="mt-3 break-words border-l-2 border-border pl-3 text-sm text-muted">{c.quote}</blockquote>)}
            </div> : null}
            {research.review ? <div className="mt-4 space-y-3">
              <h3 className="font-display text-base">审核记录</h3>
              <p className="text-sm text-muted">{research.review.checks.filter(c => c.status === "not_checked").length ? "包含尚未完成的检查，不能视为通过。" : "各项结论仅对应本任务的固定草稿和材料。"}</p>
              <ul className="space-y-1 text-sm text-muted">{research.review.checks.map(check => <li key={check.id}>{checkNames[check.id] ?? check.id}：{check.status === "pass" ? "通过" : check.status === "fail" ? "未通过" : "未检查"}</li>)}</ul>
              {research.review.findings.map((finding, i) => <div key={`${finding.code}:${i}`} className="break-words border-l-2 border-border pl-3 text-sm">
                <p>{finding.severity === "blocking" ? "阻断问题" : "建议"}：{finding.claim}</p>
                <p className="mt-1 text-muted">{finding.reason}</p><p className="mt-1 text-muted">{finding.suggestion}</p>
              </div>)}
            </div> : null}
          </> : null}
        </section>
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
