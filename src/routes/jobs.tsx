import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { listJobsFn } from "@/lib/server/fns";
import { formatDateTime } from "@/lib/format";
import { isPlatform } from "@/lib/platforms";

export const Route = createFileRoute("/jobs")({ component: JobsPage });

function JobsPage() {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => listJobsFn() });
  return (
    <AppShell title="任务" kicker="Incremental crawls">
      <p className="max-w-2xl text-sm text-muted">
        每个信源或关键词一次增量扫描对应一条 job。记录发现条数、新入库条数和错误。控制平面在线时扫描到期任务。
      </p>
      <div className="mt-5 overflow-x-auto rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
            <tr>
              <th className="px-4 py-3 font-medium">时间</th>
              <th className="px-4 py-3 font-medium">信源</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">发现</th>
              <th className="px-4 py-3 font-medium">新增</th>
              <th className="px-4 py-3 font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {(jobs.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted">
                  尚无任务。回到总览执行「扫描到期」。
                </td>
              </tr>
            ) : (
              jobs.data?.map((job) => (
                <tr key={job.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-muted">{formatDateTime(job.started_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span>{job.keyword_id ? `关键词 · ${job.source_name}` : job.source_name}</span>
                      <PlatformChip platform={isPlatform(job.platform) ? job.platform : "rss"} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={job.status === "ok" ? "live" : job.status === "error" ? "danger" : "warn"}>
                      {job.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{job.items_found}</td>
                  <td className="px-4 py-3 tabular-nums">{job.items_new}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-xs text-muted">{job.error || job.kind}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-sm text-muted">
        管道说明见 <Link to="/pipeline" className="text-fg underline-offset-2 hover:underline">采集管道</Link>
      </p>
    </AppShell>
  );
}
