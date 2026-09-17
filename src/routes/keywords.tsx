import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { PlatformChip } from "@/components/platform-chip";
import {
  addKeywordsFn,
  listItemsFn,
  listKeywordsFn,
  removeKeywordFn,
  scanKeywordFn,
  toggleKeywordFn,
} from "@/lib/server/fns";
import { KEYWORD_SEARCH_PLATFORMS, parseKeywordList } from "@/lib/keyword";
import { INTERVALS, type PlatformId } from "@/lib/platforms";
import { formatRelative, truncate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/keywords")({ component: KeywordsPage });

function KeywordsPage() {
  const qc = useQueryClient();
  const keywords = useQuery({ queryKey: ["keywords"], queryFn: () => listKeywordsFn() });
  const hits = useQuery({
    queryKey: ["keyword-hits"],
    queryFn: () => listItemsFn({ data: { limit: 24 } }),
  });
  const scan = useMutation({
    mutationFn: (id: string) => scanKeywordFn({ data: { id } }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.items_new > 0) toast.success(`「${r.phrase}」新入库 ${r.items_new} 条`);
      else if (r.error) toast(r.error);
      else toast(`「${r.phrase}」已扫描，暂无新条目`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => toggleKeywordFn({ data: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["keywords"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeKeywordFn({ data: { id } }),
    onSuccess: () => {
      toast("已停止该词的定时收集");
      void qc.invalidateQueries({ queryKey: ["keywords"] });
    },
  });

  const tagged = (hits.data ?? []).filter((it) => it.matched_keywords.length > 0);

  return (
    <AppShell title="关键词雷达" kicker="Keyword · scheduled">
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        设定行业词，按 5 / 10 / 30 分钟增量收集。标「检索」的范围会发起外部查询：新闻 RSS（Google News 中英文 + Hacker News）、B 站搜索、YouTube
        新闻索引（经 Google News 的 site:youtube.com，不是全站视频搜索）；标「信源」的范围不发起外部请求，只在已采集到的内容里匹配并打标签。词可以是「固态电池」，也可以一次粘贴多个。
      </p>

      <AddKeywordForm />

      <section className="mt-8">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-display text-xl tracking-tight">正在监听</h2>
          <p className="font-mono text-[11px] text-faint">{keywords.data?.length ?? 0} 个词</p>
        </div>
        {(keywords.data ?? []).length === 0 ? (
          <p className="rounded-lg bg-surface px-4 py-10 text-center text-sm text-muted shadow-[var(--shadow-border)]">
            还没有关键词。在上方加入行业词后开始定时收集。
          </p>
        ) : (
          <div className="grid gap-2">
            {(keywords.data ?? []).map((k) => (
              <div
                key={k.id}
                className="flex flex-col gap-3 rounded-lg bg-surface px-4 py-4 shadow-[var(--shadow-border)] sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/inbox"
                      search={{ keyword: k.phrase }}
                      className="text-sm font-medium hover:underline"
                    >
                      {k.phrase}
                    </Link>
                    <Badge tone={k.status === "ok" ? "live" : k.status === "error" ? "danger" : "muted"}>
                      {k.status}
                    </Badge>
                    {!k.enabled ? <Badge>停用</Badge> : null}
                    <Badge tone="accent">{k.hits} 命中</Badge>
                  </div>
                  <p className="mt-1.5 font-mono text-[11px] text-faint">
                    每 {k.interval_minutes} 分钟
                    {k.platforms.length ? ` · ${k.platforms.join(" / ")}` : " · 全平台"}
                    {" · "}
                    {formatRelative(k.last_scanned_at)}
                  </p>
                  {k.last_error ? <p className="mt-1 text-xs text-muted">{k.last_error}</p> : null}
                  {k.notes ? <p className="mt-1 text-xs text-muted">{k.notes}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={scan.isPending || !k.enabled}
                    onClick={() => scan.mutate(k.id)}
                  >
                    <RefreshCw
                      className={cn("size-3.5", scan.isPending && scan.variables === k.id && "animate-spin")}
                    />
                    立即收集
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggle.mutate({ id: k.id, enabled: !k.enabled })}
                  >
                    {k.enabled ? "暂停" : "启用"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(k.id)}>
                    移除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-display text-xl tracking-tight">最近命中</h2>
          <Link to="/inbox" className="text-sm text-muted hover:text-fg">
            打开内容库
          </Link>
        </div>
        <div className="divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
          {tagged.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">
              扫描后，匹配关键词的条目会出现在这里。
            </p>
          ) : (
            tagged.slice(0, 16).map((item) => (
              <Link
                key={item.id}
                to="/inbox/$itemId"
                params={{ itemId: item.id }}
                className="block px-4 py-4 hover:bg-raised/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformChip platform={item.platform} />
                  {item.matched_keywords.map((phrase) => (
                    <Badge key={phrase} tone="live">
                      {phrase}
                    </Badge>
                  ))}
                  <span className="font-mono text-[11px] text-faint">
                    {item.source_name} · {formatRelative(item.published_at ?? item.collected_at)}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-snug">{item.title}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{truncate(item.body, 140)}</p>
              </Link>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}

function AddKeywordForm() {
  const qc = useQueryClient();
  const [raw, setRaw] = useState("");
  const [interval, setInterval] = useState(30);
  const [platforms, setPlatforms] = useState<PlatformId[]>(["rss", "bilibili", "youtube"]);
  const preview = parseKeywordList(raw);

  const add = useMutation({
    mutationFn: () =>
      addKeywordsFn({
        data: { phrases: raw, interval_minutes: interval, platforms },
      }),
    onSuccess: async (r) => {
      toast.success(`已加入 ${r.count} 个关键词，开始首次收集`);
      setRaw("");
      void qc.invalidateQueries({ queryKey: ["keywords"] });
      for (const id of r.ids.slice(0, 3)) {
        await scanKeywordFn({ data: { id } });
      }
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function togglePlatform(id: PlatformId) {
    setPlatforms((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));
  }

  return (
    <form
      className="mt-6 rounded-lg bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <Search className="size-4 text-muted" strokeWidth={1.75} />
        <h2 className="font-display text-xl tracking-tight">设定关键字</h2>
      </div>
      <p className="mt-1 text-sm text-muted">逗号、顿号或换行分隔。加入后按间隔自动增量收集，只入库未见过的条目。</p>
      <Textarea
        className="mt-4"
        rows={3}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={"固态电池，人形机器人\n智能驾驶"}
        required
      />
      {preview.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {preview.map((p) => (
            <Badge key={p}>{p}</Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="mb-2 text-xs text-muted">收集范围</p>
          <div className="flex flex-wrap gap-1.5">
            {KEYWORD_SEARCH_PLATFORMS.map((p) => {
              const on = platforms.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePlatform(p.id)}
                  className={cn(
                    "h-9 rounded-full px-3 text-xs transition-colors",
                    on ? "bg-accent text-accent-fg" : "bg-raised text-muted hover:text-fg",
                  )}
                >
                  {p.label}
                  <span className="ml-1 text-[10px] opacity-70">{p.mode === "search" ? "检索" : "信源"}</span>
                </button>
              );
            })}
          </div>
        </div>
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
      <div className="mt-4 flex justify-end">
        <Button type="submit" disabled={add.isPending || preview.length === 0}>
          <Plus className="size-4" />
          {add.isPending ? "写入并收集中" : "加入定时收集"}
        </Button>
      </div>
    </form>
  );
}
