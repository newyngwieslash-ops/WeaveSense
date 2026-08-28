import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { extractPendingFn, ingestMediaFn, nodesStatusFn } from "@/lib/server/fns";

export const Route = createFileRoute("/nodes")({ component: NodesPage });

function NodesPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["nodes"], queryFn: () => nodesStatusFn() });
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
        控制面仍在这边编排。Telethon 与 MinIO 是 Docker 里的长驻节点：没连上时 Telegram 回退
        t.me/s，媒体保留远程 URL。OCR / ASR 走 Grok，只在你按键时调用。
      </p>

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
          分钟间隔即可；FloodWait 由 Telethon 节点回报后自动推迟。
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
