import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { bootstrapFn, overviewFn, tickFn } from "@/lib/server/fns";
import { PLATFORM_LIST, PLATFORMS, type PlatformId } from "@/lib/platforms";
import { formatCount, formatRelative, truncate } from "@/lib/format";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const qc = useQueryClient();
  const ticked = useRef(false);
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => overviewFn() });
  const tick = useMutation({
    mutationFn: () => tickFn(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      const kw = r.jobs.filter((j) => j.kind === "keyword").length;
      if (r.items_new > 0) {
        toast.success(
          kw ? `新入库 ${r.items_new} 条（含关键词雷达）` : `公开信源新入库 ${r.items_new} 条`,
        );
      } else if (r.ran > 0) toast("到期任务已扫描，暂无新条目");
      else toast("没有到期任务");
    },
    onError: () => toast.error("扫描失败"),
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await bootstrapFn();
      if (cancelled) return;
      await qc.invalidateQueries({ queryKey: ["overview"] });
      if (!ticked.current) {
        ticked.current = true;
        tick.mutate();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && !tick.isPending) tick.mutate();
    }, 120_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = overview.data;
  const maxItems = Math.max(1, ...(data?.platforms.map((p) => p.items) ?? [1]));

  return (
    <AppShell
      title="织识"
      kicker="行业媒体矩阵"
      cinema
      action={
        <Button size="sm" onClick={() => tick.mutate()} disabled={tick.isPending}>
          <RefreshCw className={`size-4 ${tick.isPending ? "animate-spin" : ""}`} />
          {tick.isPending ? "扫描中" : "扫描到期"}
        </Button>
      }
    >
      <section className="relative isolate min-h-[72svh] overflow-hidden lg:min-h-dvh">
        <video
          className="absolute inset-0 size-full object-cover motion-reduce:hidden"
          autoPlay
          muted
          loop
          playsInline
          poster="/hero-area.jpg"
          aria-hidden="true"
        >
          <source src="/hero-area.mp4" type="video/mp4" />
        </video>
        <img
          src="/hero-area.jpg"
          alt=""
          className="absolute inset-0 hidden size-full object-cover motion-reduce:block"
        />
        <div className="hero-veil absolute inset-0" />
        <div className="wire-room pointer-events-none absolute inset-[10%] sm:inset-[12%] lg:inset-[14%_16%]" />
        <div className="wire-room-inner pointer-events-none absolute inset-[22%] sm:inset-[24%] lg:inset-[28%_26%]" />

        <div className="relative z-10 flex min-h-[72svh] flex-col justify-end px-5 pb-10 pt-24 sm:px-8 lg:min-h-dvh lg:px-12 lg:pb-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-white/55">
            Media Matrix · Incremental
          </p>
          <h1 className="mt-3 max-w-xl font-display text-[3.25rem] leading-[0.92] tracking-tight text-fg sm:text-6xl lg:text-7xl">
            织识
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-white/70 sm:text-base">
            把频道、关键词与时间织进同一条增量管道。只取新消息，落入知识库。
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              to="/keywords"
              className="inline-flex h-11 items-center bg-accent px-5 text-sm text-accent-fg transition-opacity duration-150 hover:opacity-90"
            >
              设定关键词
            </Link>
            <Link
              to="/guide"
              className="inline-flex h-11 items-center border border-white/20 px-5 text-sm text-fg transition-colors duration-150 hover:border-white/40"
            >
              使用指南
            </Link>
            <a
              href="/zhishi-loom-source.zip"
              download
              className="inline-flex h-11 items-center border border-white/20 px-5 text-sm text-fg transition-colors duration-150 hover:border-white/40"
            >
              下载完整版
            </a>
          </div>

          <dl className="mt-12 grid grid-cols-2 gap-px bg-white/15 sm:grid-cols-4">
            <HeroStat label="信源" value={data?.source_count} hint={`${data?.enabled_count ?? 0} 启用`} />
            <HeroStat
              label="关键词"
              value={data?.keyword_count}
              hint={`${data?.keyword_hits ?? 0} 命中`}
            />
            <HeroStat label="已入库" value={data?.item_count} hint={`24h ${data?.new_24h ?? 0}`} />
            <HeroStat
              label="到期"
              value={(data?.due_count ?? 0) + (data?.keyword_due ?? 0)}
              hint={tick.isPending ? "扫描中" : "信源 + 雷达"}
              live={!!(data?.due_count || data?.keyword_due)}
            />
          </dl>
        </div>
      </section>

      <div className="px-5 py-12 sm:px-8 lg:px-12">
        <section>
          <div className="mb-5 flex items-end justify-between">
            <div>
              <h2 className="font-display text-2xl tracking-tight">矩阵房间</h2>
              <p className="mt-1 text-sm text-muted">八个平台，同一套游标与归一化字段</p>
            </div>
            <Link to="/pipeline" className="hidden items-center gap-1 text-sm text-muted hover:text-fg sm:flex">
              管道
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-px bg-white/12 lg:grid-cols-4">
            {PLATFORM_LIST.map((p) => {
              const stat = data?.platforms.find((x) => x.platform === p.id);
              const items = stat?.items ?? 0;
              return (
                <Link
                  key={p.id}
                  to="/inbox"
                  search={{ platform: p.id }}
                  className="bg-bg p-4 transition-colors duration-150 hover:bg-raised/80"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <p.icon className="size-4 text-muted" strokeWidth={1.5} />
                      <span>{p.name}</span>
                    </div>
                    <Badge tone={p.live ? "live" : "muted"}>{p.live ? "实采" : "适配"}</Badge>
                  </div>
                  <p className="mt-6 font-display text-3xl tabular-nums tracking-tight">{formatCount(items)}</p>
                  <p className="mt-1 font-mono text-[11px] text-faint">
                    {stat?.sources ?? 0} 信源 · {formatRelative(stat?.last_scanned_at)}
                  </p>
                  <div className="mt-4 h-px bg-white/10">
                    <div
                      className="h-px bg-white/55"
                      style={{ width: `${Math.max(8, (items / maxItems) * 100)}%` }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between">
            <div>
              <h2 className="font-display text-2xl tracking-tight">关键词雷达</h2>
              <p className="mt-1 text-sm text-muted">自设行业词，按间隔增量收集</p>
            </div>
            <Link to="/keywords" className="hidden items-center gap-1 text-sm text-muted hover:text-fg sm:flex">
              管理
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <div className="flex flex-wrap gap-px bg-white/12">
            {(data?.recent_keywords ?? []).length === 0 ? (
              <Link to="/keywords" className="bg-bg px-4 py-5 text-sm text-muted">
                还没有关键词。去设定行业词开始定时收集。
              </Link>
            ) : (
              data?.recent_keywords.map((k) => (
                <Link
                  key={k.id}
                  to="/inbox"
                  search={{ keyword: k.phrase }}
                  className="min-w-[11rem] flex-1 bg-bg px-4 py-4 transition-colors hover:bg-raised/80"
                >
                  <p className="text-sm">{k.phrase}</p>
                  <p className="mt-1.5 font-mono text-[11px] text-faint">
                    {k.hits} 命中 · 每 {k.interval_minutes} 分钟
                  </p>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="mt-14 grid gap-px bg-white/12 lg:grid-cols-5">
          <div className="bg-bg p-5 lg:col-span-3">
            <h2 className="font-display text-2xl tracking-tight">最新入库</h2>
            <div className="mt-4 divide-y divide-white/10">
              {(data?.recent_items ?? []).length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">
                  {overview.isLoading || tick.isPending ? "正在接入公开信源…" : "还没有内容"}
                </p>
              ) : (
                data?.recent_items.map((item) => (
                  <Link
                    key={item.id}
                    to="/inbox/$itemId"
                    params={{ itemId: item.id }}
                    className="flex gap-3 py-3.5 transition-colors hover:text-white"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <PlatformChip platform={item.platform as PlatformId} />
                        <span className="font-mono text-[11px] text-faint">
                          {formatRelative(item.published_at ?? item.collected_at)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm leading-snug">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{truncate(item.body, 110)}</p>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
          <div className="bg-bg p-5 lg:col-span-2">
            <h2 className="font-display text-2xl tracking-tight">采集任务</h2>
            <div className="mt-4 divide-y divide-white/10">
              {(data?.recent_jobs ?? []).length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">扫描后将出现任务记录</p>
              ) : (
                data?.recent_jobs.map((job) => (
                  <div key={job.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm">{job.source_name}</p>
                      <Badge tone={job.status === "ok" ? "live" : job.status === "error" ? "danger" : "warn"}>
                        {job.status === "ok" ? `+${job.items_new}` : job.status}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {PLATFORMS[job.platform as PlatformId]?.name} · {formatRelative(job.started_at)}
                      {job.error ? ` · ${job.error}` : ""}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function HeroStat({
  label,
  value,
  hint,
  live,
}: {
  label: string;
  value?: number;
  hint: string;
  live?: boolean;
}) {
  return (
    <div className="bg-bg/85 px-4 py-4 backdrop-blur-[2px]">
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
        {live ? <span className="live-dot size-1.5 rounded-full bg-live" /> : null}
        {label}
      </p>
      <p className="mt-2 font-display text-3xl tabular-nums tracking-tight sm:text-4xl">{value ?? "—"}</p>
      <p className="mt-1 text-xs text-white/45">{hint}</p>
    </div>
  );
}
