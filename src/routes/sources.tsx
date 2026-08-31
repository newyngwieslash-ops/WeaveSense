import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import {
  addSourceFn,
  addTelegramChannelsFn,
  importWechatSourcesFn,
  listSourcesFn,
  listWechatHealthFn,
  previewWechatImportFn,
  scanSourceFn,
  toggleSourceFn,
} from "@/lib/server/fns";
import type { WechatImportPreview } from "@/lib/server/wechat-import";
import { RADAR_SOURCE_ID } from "@/lib/keyword";
import { INTERVALS, PLATFORMS, PLATFORM_LIST, type PlatformId } from "@/lib/platforms";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sources")({ component: SourcesPage });

function SourcesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => listSourcesFn() });
  const hasWechatSources = Boolean(sources.data?.some((source) =>
    source.platform === "wechat" && source.id !== RADAR_SOURCE_ID));
  const wechatHealth = useQuery({ queryKey: ["wechat-health"], queryFn: () => listWechatHealthFn(),
    enabled: hasWechatSources });
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
  const healthBySource = new Map(wechatHealth.data?.sources.map((row) => [row.source_id, row]) ?? []);
  const healthLabel = { normal: "正常", degraded: "降级", paid_fallback: "付费兜底", alert: "告警" } as const;

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
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <platform.icon className="size-4 text-muted" />
              <h2 className="font-display text-xl tracking-tight">{platform.name}</h2>
              <span className="font-mono text-[11px] text-faint">{platform.foundation}</span>
              {platform.id === "wechat" && rows.length ? (
                <span className="text-xs text-muted sm:ml-auto">
                  {wechatHealth.data?.available && wechatHealth.data.usage
                    ? `今日付费 ${wechatHealth.data.usage.calls} 次 · ¥${wechatHealth.data.usage.amount.toFixed(2)}`
                    : wechatHealth.data && !wechatHealth.data.available
                      ? `网关健康不可用 · ${wechatHealth.data.error}` : "正在读取网关健康"}
                </span>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted">尚未接入</p>
            ) : (
              <div className="divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
                {rows.map((s) => {
                  const health = platform.id === "wechat" ? healthBySource.get(s.id) : undefined;
                  return <div key={s.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{s.name}</p>
                        <Badge tone={s.status === "ok" ? "live" : s.status === "error" ? "danger" : "muted"}>
                          {s.status}
                        </Badge>
                        {!s.enabled ? <Badge>停用</Badge> : null}
                        {health ? <Badge tone={health.alert_state === "normal" ? "live"
                          : health.alert_state === "alert" ? "danger" : "warn"}>
                          {healthLabel[health.alert_state]}
                        </Badge> : null}
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
                      {health ? (
                        <div className="mt-1 space-y-0.5 text-xs text-muted">
                          <p>Primary 最近成功 {formatRelative(health.last_primary_ok_at)} · 连续失败 {health.consecutive_primary_failures}</p>
                          <p>付费最近检查 {formatRelative(health.last_paid_check_at)} · {health.last_paid_result || "未调用"}</p>
                        </div>
                      ) : platform.id === "wechat" && wechatHealth.data?.available ? (
                        <p className="mt-1 text-xs text-muted">暂无网关健康数据</p>
                      ) : null}
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
                  </div>;
                })}
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
  const [wechatMode, setWechatMode] = useState<"single" | "csv">("single");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [feed, setFeed] = useState("");
  const [bulk, setBulk] = useState("");
  const [interval, setInterval] = useState(30);
  const [csv, setCsv] = useState("");
  const [previewedCsv, setPreviewedCsv] = useState("");
  const [csvPreview, setCsvPreview] = useState<WechatImportPreview | null>(null);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [csvError, setCsvError] = useState("");
  const [importFailures, setImportFailures] = useState<
    Array<{ line: number; name: string; error: string }>
  >([]);
  const def = PLATFORMS[platform];
  const resetCsvResult = () => {
    setPreviewedCsv("");
    setCsvPreview(null);
    setSelectedLines(new Set());
    setCsvError("");
    setImportFailures([]);
  };
  const updateCsv = (value: string) => {
    setCsv(value);
    resetCsvResult();
  };
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
  const previewCsv = useMutation({
    mutationFn: (value: string) => previewWechatImportFn({ data: { csv: value } }),
    onSuccess: (result, value) => {
      setPreviewedCsv(value);
      setCsvPreview(result);
      setSelectedLines(new Set(result.rows
        .filter((row) => row.status === "valid")
        .map((row) => row.line)));
      setCsvError("");
      setImportFailures([]);
    },
    onError: (error: Error) => {
      setCsvError(error.message);
      toast.error(error.message);
    },
  });
  const importCsv = useMutation({
    mutationFn: () => importWechatSourcesFn({
      data: { csv: previewedCsv, confirmed_lines: [...selectedLines] },
    }),
    onSuccess: (result) => {
      const summary = `创建 ${result.created} · 跳过 ${result.skipped} · 失败 ${result.failed.length}`;
      if (result.failed.length) toast.warning(summary);
      else toast.success(summary);
      void Promise.all([
        qc.invalidateQueries({ queryKey: ["sources"] }),
        qc.invalidateQueries({ queryKey: ["overview"] }),
        qc.invalidateQueries({ queryKey: ["wechat-health"] }),
      ]);
      setImportFailures(result.failed);
      if (result.failed.length) {
        setSelectedLines(new Set(result.failed.map((failure) => failure.line)));
      } else {
        onClose();
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const csvMode = platform === "wechat" && wechatMode === "csv";
  const csvBusy = previewCsv.isPending || importCsv.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-bg/75"
        onClick={onClose}
        disabled={csvBusy}
        aria-label={csvBusy ? "正在处理，暂时无法关闭" : "关闭"}
      />
      <form
        aria-busy={csvBusy}
        className={cn(
          "relative max-h-dvh min-w-0 w-full overflow-y-auto rounded-t-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:rounded-xl",
          csvMode ? "max-w-4xl" : "max-w-lg",
        )}
        onSubmit={(e) => {
          e.preventDefault();
          if (csvMode) {
            if (csvPreview && selectedLines.size) importCsv.mutate();
          } else if (platform === "telegram" && bulk.trim()) bulkAdd.mutate();
          else add.mutate();
        }}
      >
        <h2 className="font-display text-2xl tracking-tight">接入信源</h2>
        <p className="mt-1 text-sm text-muted">{def.blurb}</p>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1.5 text-xs text-muted">
            平台
            <NativeSelect
              value={platform}
              disabled={csvBusy}
              onChange={(e) => {
                setPlatform(e.target.value as PlatformId);
                setWechatMode("single");
                setCsv("");
                resetCsvResult();
              }}
            >
              {PLATFORM_LIST.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          {platform === "wechat" ? (
            <div className="grid grid-cols-2 gap-1 rounded-md bg-raised p-1" aria-label="微信公众号接入方式">
              <Button
                type="button"
                variant={wechatMode === "single" ? "outline" : "ghost"}
                aria-pressed={wechatMode === "single"}
                disabled={csvBusy}
                onClick={() => {
                  if (wechatMode !== "single") resetCsvResult();
                  setWechatMode("single");
                }}
              >
                单个
              </Button>
              <Button
                type="button"
                variant={wechatMode === "csv" ? "outline" : "ghost"}
                aria-pressed={wechatMode === "csv"}
                disabled={csvBusy}
                onClick={() => {
                  if (wechatMode !== "csv") resetCsvResult();
                  setWechatMode("csv");
                }}
              >
                CSV 批量
              </Button>
            </div>
          ) : null}
          {csvMode ? (
            <>
              <label className="grid gap-1.5 text-xs text-muted">
                CSV 文件
                <Input
                  type="file"
                  accept=".csv"
                  disabled={csvBusy}
                  onChange={async (event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    if (file.size > 1024 * 1024) {
                      setCsv("");
                      resetCsvResult();
                      setCsvError("CSV 文件不能超过 1 MiB");
                      event.currentTarget.value = "";
                      return;
                    }
                    try {
                      updateCsv(await file.text());
                    } catch {
                      setCsv("");
                      resetCsvResult();
                      setCsvError("CSV 文件读取失败");
                    }
                  }}
                />
              </label>
              <label className="grid gap-1.5 text-xs text-muted">
                或粘贴 CSV
                <Textarea
                  value={csv}
                  onChange={(event) => updateCsv(event.target.value)}
                  rows={7}
                  className="font-mono"
                  disabled={csvBusy}
                  placeholder={"name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority\n示例科技,gh_example,https://mp.weixin.qq.com/s/example,https://feeds.example.com/example.atom,60,normal"}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!csv.trim() || csvBusy}
                  onClick={() => {
                    resetCsvResult();
                    previewCsv.mutate(csv);
                  }}
                >
                  {previewCsv.isPending ? "校验中" : "预览"}
                </Button>
                {csvPreview ? (
                  <div className="flex flex-wrap gap-2" aria-label="CSV 预览统计">
                    <Badge tone="live">有效 {csvPreview.valid}</Badge>
                    <Badge tone="muted">重复 {csvPreview.duplicate}</Badge>
                    <Badge tone={csvPreview.error ? "danger" : "muted"}>错误 {csvPreview.error}</Badge>
                  </div>
                ) : null}
              </div>
              {csvError ? <p role="alert" className="text-sm text-danger">{csvError}</p> : null}
              {csvPreview ? (
                <div className="min-w-0 max-w-full overflow-x-auto rounded-lg shadow-[var(--shadow-border)]">
                  <table className="min-w-3xl w-full text-left text-xs">
                    <thead className="bg-raised text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">选择</th>
                        <th className="px-3 py-2 font-medium">行</th>
                        <th className="px-3 py-2 font-medium">名称</th>
                        <th className="px-3 py-2 font-medium">微信 ID</th>
                        <th className="px-3 py-2 font-medium">优先级</th>
                        <th className="px-3 py-2 font-medium">校验结果</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {csvPreview.rows.map((row) => {
                        const selectable = row.status === "valid";
                        return (
                          <tr key={row.line}>
                            <td className="px-1 py-0">
                              <label className="flex min-h-11 min-w-11 items-center justify-center">
                                <input
                                  type="checkbox"
                                  aria-label={`选择第 ${row.line} 行`}
                                  disabled={!selectable}
                                  checked={selectable && selectedLines.has(row.line)}
                                  onChange={(event) => {
                                    setSelectedLines((current) => {
                                      const next = new Set(current);
                                      if (event.target.checked) next.add(row.line);
                                      else next.delete(row.line);
                                      return next;
                                    });
                                  }}
                                  className="size-4 accent-accent"
                                />
                              </label>
                            </td>
                            <td className="px-3 py-2 font-mono text-faint">{row.line}</td>
                            <td className="px-3 py-2 text-fg">{row.value?.name || row.input?.name || "—"}</td>
                            <td className="px-3 py-2 font-mono text-faint">{row.value?.wechat_id || row.input?.wechat_id || "—"}</td>
                            <td className="px-3 py-2 text-muted">{row.value?.priority || row.input?.priority || "—"}</td>
                            <td className={cn("px-3 py-2", row.errors.length ? "text-danger" : "text-muted")}>
                              {row.errors.length ? row.errors.join("；") : "可导入"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {importFailures.length ? (
                <div role="alert" className="rounded-md bg-danger/10 p-3 text-sm text-danger">
                  <p className="font-medium">以下行未导入，可修正后重新预览，或直接重试：</p>
                  <ul className="mt-2 space-y-1">
                    {importFailures.map((failure) => (
                      <li key={`${failure.line}:${failure.name}`}>
                        第 {failure.line} 行 · {failure.name || "未命名"} · {failure.error}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <>
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
                  <Textarea
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    rows={6}
                    placeholder={"durov\ntelegram\nhttps://t.me/s/bbc"}
                    className="min-h-28 font-mono"
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
            </>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={csvBusy}>
            取消
          </Button>
          <Button
            type="submit"
            disabled={csvMode
              ? !csvPreview || selectedLines.size === 0 || importCsv.isPending
              : add.isPending || bulkAdd.isPending}
          >
            {csvMode
              ? importCsv.isPending ? "导入中" : `确认导入 ${selectedLines.size} 个公众号`
              : add.isPending || bulkAdd.isPending ? "写入中"
                : platform === "telegram" && bulk.trim() ? "批量加入" : "加入矩阵"}
          </Button>
        </div>
      </form>
    </div>
  );
}
