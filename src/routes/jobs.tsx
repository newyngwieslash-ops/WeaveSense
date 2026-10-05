import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { listJobsFn, collectionHealthFn } from "@/lib/server/fns";
import { formatDateTime } from "@/lib/format";
import { isPlatform } from "@/lib/platforms";
import { attemptLabel, telegramChannelKind, telegramChannelLabel } from "@/lib/telegram-channel";

export const Route = createFileRoute("/jobs")({ component: JobsPage });

function JobsPage() {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => listJobsFn(), refetchInterval:60000 });
  const health = useQuery({queryKey:['collection-health'],queryFn:()=>collectionHealthFn(),refetchInterval:60000});
  return (
    <AppShell title="任务" kicker="Incremental crawls">
      <p className="max-w-2xl text-sm text-muted">
        每个信源或关键词一次增量扫描对应一条 job。记录发现条数、新入库条数和错误。控制平面在线时扫描到期任务。
      </p>
      <div className="mt-4 space-y-1 text-sm text-muted">
        <p>最近 24 小时已结束任务失败 / 总数（含已记录的上游部分失败；排除运行中，按扫描起始时间）：</p>
        <p>付费兜底单独标记，不据此推断主源请求失败；旧记录缺少的指标保持未知。</p>
        {health.data?.adapter_jobs.map(row=><p key={String(row.adapter)}>{String(row.adapter)} · {Number(row.failed)} / {Number(row.total)} · {Number(row.total) ? `${(Number(row.failed)/Number(row.total)*100).toFixed(1)}%` : '未知'}</p>)}
        {health.isPending ? <p>正在读取任务指标…</p> : null}
        {health.error ? <p role="alert">指标读取失败：{health.error.message}</p> : null}
      </div>
      <div className="mt-5 divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {(jobs.data ?? []).length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">尚无任务。回到总览执行「扫描到期」。</p>
        ) : jobs.data?.map((job) => (
          <article key={job.id} className="grid gap-3 px-4 py-4 text-sm sm:grid-cols-[minmax(0,1.4fr)_auto_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{job.keyword_id ? `关键词 · ${job.source_name}` : job.source_name}</span>
                <PlatformChip platform={isPlatform(job.platform) ? job.platform : "rss"} />
                {job.platform === "telegram" ? (() => {
                  const channel = telegramChannelKind(job.attempts);
                  const label = telegramChannelLabel(channel);
                  return label ? (
                    <Badge tone={channel === "telethon" ? "live" : "warn"}>{label}</Badge>
                  ) : null;
                })() : null}
                <Badge tone={job.status === "ok" ? "live" : job.status === "error" ? "danger" : "warn"}>
                  {job.status}
                </Badge>
                {job.paid_call ? <Badge tone="warn">付费</Badge> : null}
              </div>
              <p className="mt-1 font-mono text-xs text-muted">{formatDateTime(job.started_at)}</p>
              <p className="mt-1 break-words text-xs text-muted">
                Provider {job.provider || "—"} · 尝试 {job.attempts.map(attemptLabel).join(" → ") || "—"}
              </p>
              <p className="mt-1 break-words text-xs text-muted">{job.error || job.kind}</p>
              <p className="mt-1 break-words text-xs text-muted">采集器 {job.adapter ?? '未知'} · 错误码 {job.error_code ?? '未知'} · 耗时 {job.duration_ms == null ? '未知' : `${job.duration_ms} ms`} · 字节 {job.bytes ?? '未知'}</p>
              <p className="mt-1 text-xs text-muted">{job.keyword_id ? '本地标记' : '正文补全'} {job.items_updated ?? '未知'} · 无效条目 {job.items_invalid ?? '未知'} · 覆盖 {job.coverage ? job.coverage.window_only ? '当前窗口' : job.coverage.complete ? '达到边界' : '未达到边界' : '未知'}</p>
              {job.retry_at ? <p className="mt-1 break-words text-xs text-muted">最早重试 {formatDateTime(job.retry_at)} · 等待冷却，限流请勿连续扫描；授权失败请修复账号 / 地址配置。</p> : null}
            </div>
            <p className="text-xs text-muted">发现 <span className="text-sm tabular-nums text-fg">{job.items_found ?? '未知'}</span></p>
            <p className="text-xs text-muted">新增 <span className="text-sm tabular-nums text-fg">{job.items_new}</span></p>
          </article>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted">
        管道说明见 <Link to="/pipeline" className="text-fg underline-offset-2 hover:underline">采集管道</Link>
      </p>
    </AppShell>
  );
}
