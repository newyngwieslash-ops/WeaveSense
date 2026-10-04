import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
import { INTERVALS, PLATFORMS, PLATFORM_LIST, PLATFORM_CAPABILITIES, type PlatformId } from "@/lib/platforms";
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
        每个频道一条信源。能力说明是静态支持范围，接入后仍需实际扫描验证。Telegram 默认从最近 80 条开始；历史回填需已授权节点。暂停后启用会继续保存的进度。
      </p>
      {sources.isPending ? <p className="mt-4 text-sm text-muted">正在读取信源…</p> : null}
      {sources.error ? <p role="alert" className="mt-4 text-sm text-danger">信源读取失败：{sources.error.message}</p> : null}
      <div className="mt-6 space-y-8">
        {grouped.map(({ platform, rows }) => (
          <section key={platform.id}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <platform.icon className="size-4 text-muted" />
              <h2 className="font-display text-xl tracking-tight">{platform.name}</h2>
              {platform.id === "wechat" && rows.length ? (
                <span className="text-xs text-muted sm:ml-auto">
                  {wechatHealth.data?.available && wechatHealth.data.usage
                    ? `今日付费 ${wechatHealth.data.usage.calls} 次 · ¥${wechatHealth.data.usage.amount.toFixed(2)}`
                    : wechatHealth.data && !wechatHealth.data.available
                      ? `网关健康不可用 · ${wechatHealth.data.error}` : "正在读取网关健康"}
                </span>
              ) : null}
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted">{PLATFORM_CAPABILITIES[platform.id].required}</p>
            <p className="mb-3 text-xs text-muted">
              历史：{PLATFORM_CAPABILITIES[platform.id].history === "paged" ? "条件分页，Feed / 网页仅窗口" : "当前 Feed 窗口"}
              {" · "}关键词：{PLATFORM_CAPABILITIES[platform.id].search === "native" ? "原生检索，待上游验证"
                : PLATFORM_CAPABILITIES[platform.id].search === "index" ? "新闻索引" : "无原生检索，仅库内匹配"}
              {" · "}媒体：{PLATFORM_CAPABILITIES[platform.id].media === "download" ? "已授权节点可下载" : "提供引用，下载需另行验证"}
            </p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted">待配置 · 未验证</p>
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
                      <p className="mt-1 break-all font-mono text-[11px] text-faint">
                        {s.handle || s.feed_url || s.url} · 每 {s.interval_minutes} 分钟 · {s.item_count ?? 0} 条 ·{" "}
                        {formatRelative(s.last_scanned_at)}
                      </p>
                      <p className="mt-1 text-xs text-muted">最近成功验证：{s.last_success_at ? formatRelative(s.last_success_at) : "未验证"} · 最近扫描：{formatRelative(s.last_scanned_at)}</p>
                      {!s.collection_coverage ? <p className="mt-1 text-xs text-muted">覆盖范围未知，等待首次验证</p> : null}
                      {s.collection_coverage?.window_only ? <p className="mt-1 text-xs text-muted">仅覆盖当前窗口，不包含完整历史</p> : null}
                      {s.has_more ? <p className="mt-1 text-xs text-muted">还有内容待采集，将从已保存进度继续</p> : null}
                      {s.last_error ? (
                        <p className="mt-1 text-xs text-danger">{s.last_error}</p>
                      ) : (
                        <p className="mt-1 text-xs text-muted">{s.notes}</p>
                      )}
                      {health ? (
                        <div className="mt-1 space-y-0.5 text-xs text-muted">
                          <p>主源请求最近成功 {formatRelative(health.last_primary_ok_at)} · 连续失败 {health.consecutive_primary_failures}</p>
                          <p>主源内容进展 / 完整正文确认 {formatRelative(health.last_primary_content_at ?? null)} · 观察距今 {health.content_age_hours == null ? "未知" : `${health.content_age_hours.toFixed(1)} 小时`}</p>
                          <p>跨提供方观察到的最新发布时间 {formatRelative(health.latest_published_at ?? null)}</p>
                          <p>预期更新周期 {health.expected_update_hours == null ? "未知" : `${health.expected_update_hours} 小时`} · 新鲜度 {health.freshness_state === "fresh" ? "有新鲜内容证据" : health.freshness_state === "suspected_stale" ? "疑似滞后" : "未知"}</p>
                          {health.diagnostic_code ? <p>诊断：{health.diagnostic_code}（内容疑似滞后）</p> : null}
                          {health.recent_error_type === "risk_control" ? <p className="text-danger">主源明确返回限制信号</p> : null}
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
  const [bootstrap, setBootstrap] = useState<"latest" | "backfill">("latest");
  const [boundary, setBoundary] = useState("");
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
          handle: platform === "rss" ? "" : handle,
          feed_url: platform === "wechat" || (platform === "telegram" && bootstrap === "backfill") ? "" : feed,
          interval_minutes: interval,
          scan_state: platform === "telegram" ? bootstrap === "backfill" ? { bootstrap, boundary: boundary.trim() || "0" } : { bootstrap } : undefined,
        },
      }),
    onSuccess: () => {
      toast.success("已保存信源配置，待首次扫描验证");
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const bulkAdd = useMutation({
    mutationFn: () =>
      addTelegramChannelsFn({
        data: { handles: bulk, interval_minutes: interval,
          scan_state: bootstrap === "backfill" ? { bootstrap, boundary: boundary.trim() || "0" } : { bootstrap } },
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
    <Dialog.Root open onOpenChange={(open) => { if (!open && !csvBusy) onClose(); }}>
      <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/75" />
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center pointer-events-none">
      <Dialog.Content asChild aria-describedby="source-description">
      <form
        aria-busy={csvBusy}
        className={cn(
          "relative pointer-events-auto max-h-dvh min-w-0 w-full overflow-y-auto rounded-t-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:rounded-xl",
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
        <Dialog.Title asChild><h2 className="font-display text-2xl tracking-tight">接入信源</h2></Dialog.Title>
        <p id="source-description" className="mt-1 text-sm text-muted">{def.blurb}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">{PLATFORM_CAPABILITIES[platform].required}</p>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1.5 text-xs text-muted">
            平台
            <NativeSelect
              value={platform}
              disabled={csvBusy}
              onChange={(e) => {
                setPlatform(e.target.value as PlatformId);
                setWechatMode(e.target.value === "wechat" ? "csv" : "single");
                setHandle(""); setFeed(""); setBulk(""); setBootstrap("latest"); setBoundary("");
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
                关联已有网关
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
            <Fragment key="csv">
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
                  placeholder={"name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority,expected_update_hours\n示例科技,gh_example,https://mp.weixin.qq.com/s/example,https://feeds.example.com/example.atom,60,normal,24"}
                />
              </label>
              <p className="text-xs leading-relaxed text-muted">支持原六列表头。可在最后加 expected_update_hours：填正数小时（可小数），留空表示未知。扫描间隔固定 60 分钟；更新周期用于新鲜度判断。预览只校验格式，不证明上游可用。</p>
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
                        <th className="px-3 py-2 font-medium">更新周期</th>
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
                            <td className="px-3 py-2 text-muted">{row.value?.expected_update_hours == null ? "未知" : `${row.value.expected_update_hours} 小时`}</td>
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
            </Fragment>
          ) : (
            <Fragment key="single">
              <label className="grid gap-1.5 text-xs text-muted">
                名称
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="信源显示名称" required={platform !== "telegram" || !bulk.trim()} maxLength={80} />
              </label>
              {platform !== "rss" ? <label className="grid gap-1.5 text-xs text-muted">
                {def.handleLabel}
                <Input
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder={def.handlePlaceholder}
                  required={platform === "wechat" || (platform === "telegram" && !bulk.trim()) || (["youtube", "bilibili"].includes(platform) && !feed.trim())}
                />
              </label> : null}
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
              {platform === "telegram" ? <>
                <label className="grid gap-1.5 text-xs text-muted">首次采集范围
                  <NativeSelect value={bootstrap} onChange={(e) => setBootstrap(e.target.value as "latest" | "backfill")}>
                    <option value="latest">最近 80 条，随后增量</option><option value="backfill">从消息 ID 回填历史（需已授权节点）</option>
                  </NativeSelect>
                </label>
                {bootstrap === "backfill" ? <label className="grid gap-1.5 text-xs text-muted">起始消息 ID（可选，留空从 0 开始）
                  <Input value={boundary} onChange={(e) => setBoundary(e.target.value)} inputMode="numeric" pattern="[0-9]+" maxLength={320} placeholder="0" />
                </label> : null}
                <p className="text-xs text-muted">网页和 Feed 仅有限窗口；回填不会自动退回网页。暂停 / 启用保留进度。</p>
              </> : null}
              {platform !== "wechat" && !(platform === "telegram" && bootstrap === "backfill") ? <label className="grid gap-1.5 text-xs text-muted">
                RSS / Atom Feed {(["rss", "douyin", "xhs", "xigua"].includes(platform)) ? "（必填）" : "（可选；填写后使用 Feed 窗口）"}
                <Input type="url" value={feed} onChange={(e) => setFeed(e.target.value)} placeholder="https://" required={["rss", "douyin", "xhs", "xigua"].includes(platform)} />
              </label> : null}
              {platform === "wechat" ? <p className="text-xs leading-relaxed text-muted">这里只关联网关中已经配置的微信 ID，不会建立主源或更新周期。首次接入请使用 CSV 批量；已有配置不会被覆盖。</p> : null}
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
            </Fragment>
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
      </Dialog.Content>
      </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
