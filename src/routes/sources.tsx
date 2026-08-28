import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { addSourceFn, addTelegramChannelsFn, listSourcesFn, scanSourceFn, toggleSourceFn } from "@/lib/server/fns";
import { RADAR_SOURCE_ID } from "@/lib/keyword";
import { INTERVALS, PLATFORMS, PLATFORM_LIST, type PlatformId } from "@/lib/platforms";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sources")({ component: SourcesPage });

function SourcesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => listSourcesFn() });
  const scan = useMutation({
    mutationFn: (id: string) => scanSourceFn({ data: { id } }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.error && r.error !== "已停用") toast.error(r.error);
      else toast.success(`发现 ${r.items_found} · 新增 ${r.items_new}`);
    },
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => toggleSourceFn({ data: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sources"] }),
  });

  const grouped = PLATFORM_LIST.map((p) => ({
    platform: p,
    rows: (sources.data ?? []).filter((s) => s.platform === p.id && s.id !== RADAR_SOURCE_ID),
  }));

  return (
    <AppShell
      title="信源"
      kicker="Channels · last_message_id"
      action={
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          接入
        </Button>
      }
    >
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        每个频道一条信源。Telegram 可一次粘贴最多 1000 个用户名；Telethon 节点在线时走 GetHistory 增量，未连接则回退 t.me/s。行业词请到「关键词」页设定。
      </p>
      <div className="mt-6 space-y-8">
        {grouped.map(({ platform, rows }) => (
          <section key={platform.id}>
            <div className="mb-3 flex items-center gap-2">
              <platform.icon className="size-4 text-muted" />
              <h2 className="font-display text-xl tracking-tight">{platform.name}</h2>
              <span className="font-mono text-[11px] text-faint">{platform.foundation}</span>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted">尚未接入</p>
            ) : (
              <div className="divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
                {rows.map((s) => (
                  <div key={s.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{s.name}</p>
                        <Badge tone={s.status === "ok" ? "live" : s.status === "error" ? "danger" : "muted"}>
                          {s.status}
                        </Badge>
                        {!s.enabled ? <Badge>停用</Badge> : null}
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        {s.handle || s.feed_url || s.url} · 每 {s.interval_minutes} 分钟 · {s.item_count ?? 0} 条 ·{" "}
                        {formatRelative(s.last_scanned_at)}
                      </p>
                      {s.last_error ? (
                        <p className="mt-1 text-xs text-danger">{s.last_error}</p>
                      ) : (
                        <p className="mt-1 text-xs text-muted">{s.notes}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={scan.isPending || !s.enabled}
                        onClick={() => scan.mutate(s.id)}
                      >
                        <RefreshCw className={cn("size-3.5", scan.isPending && scan.variables === s.id && "animate-spin")} />
                        扫描
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                      >
                        {s.enabled ? "停用" : "启用"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      {open ? <AddSourceDialog onClose={() => setOpen(false)} /> : null}
    </AppShell>
  );
}

function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<PlatformId>("rss");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [feed, setFeed] = useState("");
  const [bulk, setBulk] = useState("");
  const [interval, setInterval] = useState(30);
  const def = PLATFORMS[platform];
  const add = useMutation({
    mutationFn: () =>
      addSourceFn({
        data: {
          platform,
          name,
          handle,
          feed_url: feed,
          interval_minutes: interval,
        },
      }),
    onSuccess: () => {
      toast.success("已接入信源");
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const bulkAdd = useMutation({
    mutationFn: () =>
      addTelegramChannelsFn({
        data: { handles: bulk, interval_minutes: interval },
      }),
    onSuccess: (r) => {
      toast.success(`接入 ${r.created} 个频道${r.skipped ? ` · 跳过 ${r.skipped} 个已存在` : ""}`);
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-bg/75" onClick={onClose} aria-label="关闭" />
      <form
        className="relative w-full max-w-lg rounded-t-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (platform === "telegram" && bulk.trim()) bulkAdd.mutate();
          else add.mutate();
        }}
      >
        <h2 className="font-display text-2xl tracking-tight">接入信源</h2>
        <p className="mt-1 text-sm text-muted">{def.blurb}</p>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1.5 text-xs text-muted">
            平台
            <NativeSelect value={platform} onChange={(e) => setPlatform(e.target.value as PlatformId)}>
              {PLATFORM_LIST.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1.5 text-xs text-muted">
            名称
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 量子位" required />
          </label>
          <label className="grid gap-1.5 text-xs text-muted">
            {def.handleLabel}
            <Input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={def.handlePlaceholder}
              required={platform !== "telegram" || !bulk.trim()}
            />
          </label>
          {platform === "telegram" ? (
            <label className="grid gap-1.5 text-xs text-muted">
              批量频道（每行一个，最多 1000）
              <textarea
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                rows={6}
                placeholder={"durov\ntelegram\nhttps://t.me/s/bbc"}
                className="min-h-28 w-full rounded-sm border-0 bg-raised px-3 py-2 font-mono text-sm text-fg outline-none ring-1 ring-border focus:ring-fg/40"
              />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-xs text-muted">
            RSS / WeWe / RSSHub（可选）
            <Input value={feed} onChange={(e) => setFeed(e.target.value)} placeholder="https://" />
          </label>
          <label className="grid gap-1.5 text-xs text-muted">
            扫描间隔
            <NativeSelect value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={add.isPending || bulkAdd.isPending}>
            {add.isPending || bulkAdd.isPending ? "写入中" : platform === "telegram" && bulk.trim() ? "批量加入" : "加入矩阵"}
          </Button>
        </div>
      </form>
    </div>
  );
}
