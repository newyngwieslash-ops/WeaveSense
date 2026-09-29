import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { listJobsFn } from "@/lib/server/fns";
import { formatDateTime } from "@/lib/format";
import { isPlatform } from "@/lib/platforms";
import { attemptLabel, telegramChannelKind, telegramChannelLabel } from "@/lib/telegram-channel";

export const Route = createFileRoute("/jobs")({ component: JobsPage });

function JobsPage() {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => listJobsFn() });
  return (
    <AppShell title="任务" kicker="Incremental crawls">
      <p className="max-w-2xl text-sm text-muted">
        每个信源或关键词一次增量扫描对应一条 job。记录发现条数、新入库条数和错误。控制平面在线时扫描到期任务。
      </p>
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
            </div>
            <p className="text-xs text-muted">发现 <span className="text-sm tabular-nums text-fg">{job.items_found}</span></p>
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
