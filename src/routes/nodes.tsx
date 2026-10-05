import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { extractPendingFn, ingestMediaFn, nodesStatusFn, replayMediaFn } from "@/lib/server/fns";

export const Route = createFileRoute("/nodes")({ component: NodesPage });

function NodesPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["nodes"], queryFn: () => nodesStatusFn(), refetchInterval:60000 });
  const replay = useMutation({
    mutationFn:(row:{id:string;next_attempt_at:string|null})=>replayMediaFn({data:{id:row.id}}),
    onSuccess:(result,row)=>{
      if (!result.requeued) toast.error('当前状态不可重试，请刷新后检查');
      else toast.success(row.next_attempt_at && Date.parse(row.next_attempt_at)>Date.now()
        ? `已开启新一轮有限尝试，保留冷却至 ${new Date(row.next_attempt_at).toLocaleString()}；媒体按半小时窗口调度`
        : '已开启新一轮有限尝试；媒体按半小时窗口调度');
      void qc.invalidateQueries({queryKey:['nodes']});
    },
    onError:(error:Error)=>toast.error(error.message),
  });
  const ingest = useMutation({
    mutationFn: () => ingestMediaFn(),
    onSuccess: (r) => {
      toast.success(`MinIO 入库 ${r.stored} · 失败 ${r.errors}`);
      void qc.invalidateQueries({ queryKey: ["nodes"] });
    },
    onError: () => toast.error("落盘失败"),
  });
  const extract = useMutation({
    mutationFn: () => extractPendingFn(),
    onSuccess: (r) => {
      toast.success(`提取 ${r.ran} · 失败 ${r.errors}`);
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const data = status.data;

  return (
    <AppShell
      title="生产节点"
      kicker="Telethon · MinIO · ASR/OCR"
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => ingest.mutate()} disabled={ingest.isPending}>
            {ingest.isPending ? "落盘中" : "媒体落盘"}
          </Button>
          <Button size="sm" onClick={() => extract.mutate()} disabled={extract.isPending}>
            {extract.isPending ? "提取中" : "处理 OCR/ASR"}
          </Button>
        </div>
      }
    >
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        控制面仍在这边编排。Telethon 与 MinIO 是长驻节点。Telegram 默认从最近 80 条开始，随后增量；
        节点未配置或未授权时可用 t.me/s 公开窗口，显式 Feed 也仅有有限窗口。
        已配置节点临时离线或冷却时等待恢复重试；历史回填需已授权节点，不会自动退回网页或 Feed。
        媒体异步落盘并按冷却重试。OCR / ASR 只在你按键时调用。
      </p>
      {status.isPending ? <p className="mt-4 text-sm text-muted">正在读取节点与指标…</p> : null}
      {status.error ? <p role="alert" className="mt-4 text-sm text-danger">节点读取失败：{status.error.message}</p> : null}
      <section className="mt-6 space-y-2 rounded-lg bg-surface p-5 text-sm text-muted shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl text-fg">采集观测</h2>
        <p>最久到期等待：{data?.collection.oldest_due_age_minutes == null ? '未知 / 无到期积压' : `${data.collection.oldest_due_age_minutes.toFixed(1)} 分钟`} · 媒体最久等待：{data?.collection.pending_media_age_minutes == null ? '未知 / 无待处理对象' : `${data.collection.pending_media_age_minutes.toFixed(1)} 分钟`}</p>
        <p>媒体按重试 / 租约已到期最久等待：{data?.collection.oldest_due_media_age_minutes == null ? '未知 / 无到期对象' : `${data.collection.oldest_due_media_age_minutes.toFixed(1)} 分钟`} · 冷却 {data?.collection.media_cooling ?? '未知'} · 已领取 {data?.collection.media_leased ?? '未知'} · 需手动恢复 {data?.collection.media_manual ?? '未知'}；领取还需节点授权就绪。</p>
        <p>发现延迟 P50 / P95（最近 24 小时首次入库，发布时间 → 首次采集）：{data?.collection.discovery.p50_seconds == null ? '未知' : `${(data.collection.discovery.p50_seconds/60).toFixed(1)} 分钟`} / {data?.collection.discovery.p95_seconds == null ? '未知' : `${(data.collection.discovery.p95_seconds/60).toFixed(1)} 分钟`}</p>
        <p>有效观察 {data?.collection.discovery.observed ?? '未知'} · 发布时间未知 {data?.collection.discovery.unknown ?? '未知'} · 未来 / 倒序时间 {data?.collection.discovery.invalid_future ?? '未知'}；不以请求耗时替代，正文补全不改变首次采集时间。</p>
        <p>正文完整率：{data?.collection.body.known ? `${(data.collection.body.complete/data.collection.body.known*100).toFixed(1)}%（已知 ${data.collection.body.complete} / ${data.collection.body.known}）` : '未知'} · 未知 {data ? data.collection.body.total-data.collection.body.known : '未知'}；正文非空不等于完整。</p>
        <p>到期等待持续增加时检查调度与出口；媒体积压检查 MinIO、节点授权和上游重试时间。媒体调度保持半小时窗口。</p>
      </section>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {(data?.nodes ?? []).map((n) => (
          <article key={n.id} className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-xl tracking-tight">{n.title}</h2>
              <Badge tone={n.status === "live" ? "live" : n.status === "wait" ? "warn" : "muted"}>
                {n.status === "live" ? "在线" : n.status === "wait" ? "待就绪" : "未配置"}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-faint">{n.role}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted">{n.detail}</p>
          </article>
        ))}
      </div>

      <section className="mt-8 grid gap-3 sm:grid-cols-2">
        <Stat title="媒体对象" items={[
          ["合计", data?.media.total ?? 0],
          ["远程", data?.media.remote ?? 0],
          ["已落盘", data?.media.stored ?? 0],
          ["失败", data?.media.error ?? 0],
        ]} />
        <Stat title="提取任务" items={[
          ["合计", data?.extracts.total ?? 0],
          ["成功", data?.extracts.ok ?? 0],
          ["进行中", data?.extracts.pending ?? 0],
          ["失败", data?.extracts.error ?? 0],
        ]} />
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="font-display text-2xl tracking-tight">媒体恢复</h2>
        <p className="text-sm text-muted">修复节点配置后，可对失败 / 耗尽对象单条开启新一轮最多 4 次尝试。保留文件标识与上游冷却，等待半小时媒体窗口。当前尝试数属于本轮。</p>
        {data?.media_failures.length===0 ? <p className="text-sm text-muted">没有需要手动恢复的对象。</p> : null}
        {data?.media_failures.map(row=><article key={row.id} className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-[var(--shadow-border)] sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-1 text-sm">
            <p className="break-words font-medium">{row.item_title || '媒体对象'}</p>
            <p className="break-all text-xs text-muted">{row.id} · {row.status} · 本轮尝试 {row.attempts}</p>
            <p className="break-words text-xs text-muted">最早重试 {row.next_attempt_at ? new Date(row.next_attempt_at).toLocaleString() : '配置修复后，等待调度'} · 请先检查存储配置与节点授权</p>
          </div>
          <Button className="min-h-11" size="sm" variant="outline" disabled={replay.isPending} onClick={()=>replay.mutate(row)} aria-label={`重试媒体 ${row.id}`}>重新尝试</Button>
        </article>)}
        {(data?.media_failures.length ?? 0)>=20 ? <p className="text-xs text-muted">仅显示最早 20 个失败对象，恢复后刷新继续。</p> : null}
      </section>

      <section className="mt-10 max-w-2xl">
        <h2 className="font-display text-2xl tracking-tight">Docker 启动</h2>
        <p className="mt-2 text-sm text-muted">
          在自己的机器上：先登录 Telethon 会话，再拉起整套。本预览不会启动这些容器。
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
          {`export TELEGRAM_API_ID=...
export TELEGRAM_API_HASH=...
export XAI_API_KEY=...          # 可选，OCR/ASR

docker compose run --rm -it telethon python login.py
docker compose up --build`}
        </pre>
        <p className="mt-3 text-sm text-muted">
          每轮扫描最多 {data?.tick_limit ?? 5} 个到期信源/关键词。一千个频道用 5–30
          分钟是可配置间隔，容量仍需实际运行验证；FloodWait 由 Telethon 节点回报后自动推迟。
        </p>
      </section>
    </AppShell>
  );
}

function Stat({ title, items }: { title: string; items: [string, number][] }) {
  return (
    <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
      <h3 className="font-display text-lg">{title}</h3>
      <dl className="mt-3 grid grid-cols-2 gap-2 font-mono text-[12px] text-muted">
        {items.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt>{k}</dt>
            <dd className="tabular-nums text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
