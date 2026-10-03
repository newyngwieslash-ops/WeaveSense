import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { coverageCopy, errorCopy, retryOrFreshRequestId } from "@/lib/agent-request";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { analyzeItemFn, extractItemFn, getItemFn } from "@/lib/server/fns";
import { MEDIA_TYPE_LABEL, type MediaType } from "@/lib/platforms";
import { formatCount, formatDateTime } from "@/lib/format";
import { isPlatform } from "@/lib/platforms";

export const Route = createFileRoute("/inbox/$itemId")({ component: ItemPage });

function ItemPage() {
  const { itemId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["item", itemId],
    queryFn: () => getItemFn({ data: { id: itemId } }),
  });
  const requestId = useRef<string | null>(null);
  const analyze = useMutation({
    mutationFn: () => {
      requestId.current = retryOrFreshRequestId(requestId.current, Boolean(requestId.current));
      return analyzeItemFn({ data: { id: itemId, request_id: requestId.current } });
    },
    onSuccess: (r) => {
      if (!r.ok) {
        const code = "error_code" in r ? String(r.error_code ?? "") : "";
        toast.error(errorCopy(code) + (r.error ? `：${r.error}` : ""));
        requestId.current = null;
      } else {
        requestId.current = null;
        toast.success("已写入知识层");
      }
      void qc.invalidateQueries({ queryKey: ["item", itemId] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const extract = useMutation({
    mutationFn: () => extractItemFn({ data: { id: itemId } }),
    onSuccess: (r) => {
      if (!r.ok) toast.error(r.error ?? "提取失败");
      else toast.success(`已提取 ${r.ran} 条 OCR/ASR`);
      void qc.invalidateQueries({ queryKey: ["item", itemId] });
    },
  });

  const item = detail.data?.item;
  const analysis = detail.data?.analysis;
  const media = detail.data?.media ?? [];
  const extracts = detail.data?.extracts ?? [];

  return (
    <AppShell
      title={item?.title ?? "条目"}
      kicker="采集详情"
      action={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => extract.mutate()}
            disabled={extract.isPending || !item}
          >
            {extract.isPending ? "提取中" : "OCR / ASR"}
          </Button>
          <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || !item} data-testid="analyze-button">
            <Sparkles className="size-4" />
            {analyze.isPending ? "分析中" : "LLM 分析"}
          </Button>
        </div>
      }
    >
      <Link to="/inbox" search={search} className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" />
        返回内容
      </Link>

      {detail.isLoading ? (
        <p className="text-sm text-muted">载入中…</p>
      ) : !item ? (
        <p className="text-sm text-muted">找不到这条内容。</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-6 [overflow-wrap:anywhere] lg:grid-cols-5">
          <article className="min-w-0 rounded-lg bg-surface p-5 shadow-[var(--shadow-border)] lg:col-span-3">
            <div className="flex flex-wrap gap-2">
              <PlatformChip platform={isPlatform(item.platform) ? item.platform : "rss"} />
              <Badge>{MEDIA_TYPE_LABEL[item.media_type as MediaType]}</Badge>
              <Badge tone={item.pipeline_status === "analyzed" ? "live" : "muted"}>
                {item.pipeline_status}
              </Badge>
              {item.matched_keywords.map((phrase) => (
                <Link key={phrase} to="/inbox" search={{ keyword: phrase }}>
                  <Badge tone="live">{phrase}</Badge>
                </Link>
              ))}
            </div>
            <h2 className="mt-4 font-display text-3xl tracking-tight">{item.title}</h2>
            <p className="mt-3 font-mono text-[11px] text-faint">
              {item.source_name} · {item.author || "未知作者"} · {formatDateTime(item.published_at)}
              {item.views != null ? ` · 浏览 ${formatCount(item.views)}` : ""}
            </p>
            {item.thumbnail_url ? (
              <img
                src={item.thumbnail_url}
                alt=""
                className="mt-5 max-h-64 w-full rounded-md object-cover"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{item.body}</div>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
              >
                打开原页
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </article>
          <aside className="min-w-0 space-y-4 lg:col-span-2">
            <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
              <h3 className="font-display text-lg">知识层</h3>
              {analysis ? (
                <div className="mt-3 space-y-3 text-sm">
                  <p className="text-xs text-muted">{coverageCopy(analysis.coverage)}</p>
                  {analysis.warnings?.length ? (
                    <p className="text-xs text-muted">{analysis.warnings.join(" · ")}</p>
                  ) : null}
                  <p className="leading-relaxed">{analysis.summary}</p>
                  {analysis.insights ? (
                    <p className="text-muted">洞察：{analysis.insights}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.topics.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    {analysis.entities.map((t) => (
                      <Badge key={t} tone="live">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  <p className="font-mono text-[11px] text-faint">{analysis.model}</p>
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted">
                  尚未分析。分析由你触发，结果写入 PostgreSQL，不会在打开页面时自动消耗额度。
                </p>
              )}
            </div>
            <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
              <h3 className="font-display text-lg">归一化字段</h3>
              <dl className="mt-3 space-y-2 font-mono text-[12px] text-muted">
                <Row k="external_id" v={item.external_id} />
                <Row k="platform" v={item.platform} />
                <Row k="media_type" v={item.media_type} />
                <Row k="collected_at" v={formatDateTime(item.collected_at)} />
                <Row k="keywords" v={item.matched_keywords.join(" / ") || "—"} />
              </dl>
            </div>
            {media.length ? (
              <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
                <h3 className="font-display text-lg">媒体对象</h3>
                <ul className="mt-3 space-y-2 font-mono text-[12px] text-muted">
                  {media.map((m) => (
                    <li key={String(m.id)} className="flex justify-between gap-2">
                      <span className="truncate">{String(m.kind)} · {String(m.status)}</span>
                      <span>{m.bytes != null ? `${m.bytes} B` : "remote"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {extracts.length ? (
              <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
                <h3 className="font-display text-lg">OCR / ASR</h3>
                <div className="mt-3 space-y-3 text-sm">
                  {extracts.map((e) => (
                    <div key={String(e.id)}>
                      <div className="flex items-center gap-2">
                        <Badge>{String(e.kind)}</Badge>
                        <Badge tone={e.status === "ok" ? "live" : e.status === "error" ? "danger" : "muted"}>
                          {String(e.status)}
                        </Badge>
                      </div>
                      {e.result_text ? (
                        <p className="mt-2 whitespace-pre-wrap text-muted">{String(e.result_text).slice(0, 800)}</p>
                      ) : (
                        <p className="mt-2 text-xs text-faint">{String(e.error || e.model || "")}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </AppShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2 sm:gap-3">
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] text-fg sm:text-right">{v}</dd>
    </div>
  );
}
