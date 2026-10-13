import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { coverageCopy, errorCopy, retryOrFreshRequestId } from "@/lib/agent-request";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlatformChip } from "@/components/platform-chip";
import { analyzeItemFn, extractItemFn, getItemFn, previewArticleFn, adoptArticleFn, restoreArticleFn, readSubtitleFn } from "@/lib/server/fns";
import { subtitleLanguages, subtitleErrorCopy, type SubtitleLanguage } from "@/lib/subtitle-contract";
import { articleErrorCopy } from "@/lib/article-contract";
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
  const readerAvailable = detail.data?.articleReader.available ?? false;
  const readerReason = detail.data?.articleReader.reason ?? "";
  const articleState = item?.extra.article_state;
  const candidate = typeof item?.extra.article_candidate === "string" ? item.extra.article_candidate : "";
  const digest = typeof item?.extra.article_digest === "string" ? item.extra.article_digest : "";
  const version = item?.material_version;
  const versionValid = typeof version === "number" && Number.isSafeInteger(version) && version >= 0;
  const candidateStale = articleState === "candidate" && item?.extra.article_candidate_version !== version;
  const [articleNotice, setArticleNotice] = useState({ itemId: "", message: "" });
  const reportArticle = (result: { ok: boolean; error?: string }, success: string) => {
    const message = result.ok ? success : result.error ?? articleErrorCopy(undefined);
    setArticleNotice({ itemId, message });
    if (result.ok) toast.success(message);
    else toast.error(message);
  };
  const refreshArticle = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["item", itemId] }),
      qc.invalidateQueries({ queryKey: ["inbox"] }),
      qc.invalidateQueries({ queryKey: ["overview"] }),
    ]);
  };
  const preview = useMutation({
    mutationFn: () => previewArticleFn({ data: { id: itemId } }),
    onMutate: () => setArticleNotice({ itemId, message: "" }),
    onSuccess: (r) => reportArticle(r, "候选正文已就绪，请核对后采用"),
    onError: () => reportArticle({ ok: false }, ""),
    onSettled: refreshArticle,
  });
  const adopt = useMutation({
    mutationFn: () => adoptArticleFn({ data: { id: itemId, digest, material_version: version! } }),
    onMutate: () => setArticleNotice({ itemId, message: "" }),
    onSuccess: (r) => reportArticle(r, "已采用正文"),
    onError: () => reportArticle({ ok: false }, ""),
    onSettled: refreshArticle,
  });
  const restore = useMutation({
    mutationFn: () => restoreArticleFn({ data: { id: itemId, material_version: version! } }),
    onMutate: () => setArticleNotice({ itemId, message: "" }),
    onSuccess: (r) => reportArticle(r, "已恢复此前正文"),
    onError: () => reportArticle({ ok: false }, ""),
    onSettled: refreshArticle,
  });
  const articlePending = preview.isPending || adopt.isPending || restore.isPending;
  const [subtitleLanguage, setSubtitleLanguage] = useState<SubtitleLanguage>("en");
  const [subtitleNotice, setSubtitleNotice] = useState({ itemId: "", message: "" });
  const subtitles = useMutation({
    mutationFn: () => readSubtitleFn({ data: { id: itemId, language: subtitleLanguage } }),
    onMutate: () => setSubtitleNotice({ itemId, message: "" }),
    onSuccess: r => setSubtitleNotice({ itemId, message: r.ok ? r.status === "no_subtitles" ? "此视频未提供可用字幕"
      : `已读取${r.kind === "manual" ? "人工" : "自动"}字幕 · ${r.language}` : r.error }),
    onError: () => setSubtitleNotice({ itemId, message: subtitleErrorCopy(undefined) }),
    onSettled: refreshArticle,
  });
  const subtitleStatus = subtitles.isPending ? "正在读取字幕…"
    : subtitleNotice.itemId === itemId && subtitleNotice.message ? subtitleNotice.message
    : item?.extra.transcript_state === "no_subtitles" ? "此视频未提供可用字幕"
    : item?.extra.transcript_state === "ok" ? `${item.extra.transcript_kind === "manual" ? "人工" : "自动"}字幕 · ${item.extra.transcript_language}`
    : !detail.data?.subtitleReader.available ? subtitleErrorCopy(detail.data?.subtitleReader.reason)
    : "读取所选语言的现有字幕，成功后附加到正文。";
  const articleStatus = preview.isPending ? "读取中…" : adopt.isPending ? "采用中…" : restore.isPending ? "恢复中…"
    : candidateStale ? articleErrorCopy("article_conflict")
    : articleNotice.itemId === itemId && articleNotice.message ? articleNotice.message
    : articleState === "adopted" ? "已采用正文，可恢复此前正文"
    : articleState === "restored" ? "已恢复此前正文"
    : articleState === "candidate" ? "候选正文已就绪，请核对后采用"
    : articleState === "error" ? articleErrorCopy(item?.extra.article_error)
    : !readerAvailable ? articleErrorCopy(readerReason)
    : "读取后先核对候选正文，采用后才会更新当前内容。";

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
            <div data-testid="item-body" className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{item.body}</div>
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
            {item.platform === "youtube" ? (
              <section className="mt-6 border-t border-border pt-5" aria-labelledby="subtitle-heading">
                <h3 id="subtitle-heading" className="font-display text-lg">视频字幕</h3>
                <p role="status" aria-live="polite" data-testid="subtitle-status" className="mt-2 text-sm text-muted">{subtitleStatus}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <label htmlFor="subtitle-language" className="text-sm text-muted">字幕语言</label>
                  <select id="subtitle-language" value={subtitleLanguage} disabled={subtitles.isPending}
                    onChange={event => setSubtitleLanguage(event.target.value as SubtitleLanguage)}
                    className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-fg">
                    {subtitleLanguages.map(language => <option key={language} value={language}>{language === "en" ? "英语" : language === "zh-Hans" ? "简体中文" : "繁体中文"}</option>)}
                  </select>
                  <Button variant="outline" data-testid="subtitle-read-button" aria-busy={subtitles.isPending}
                    disabled={subtitles.isPending || !detail.data?.subtitleReader.available} onClick={() => subtitles.mutate()}>
                    {subtitles.isPending ? "读取中…" : "读取字幕"}
                  </Button>
                </div>
              </section>
            ) : null}
            <section className="mt-6 min-w-0 border-t border-border pt-5" aria-labelledby="article-reader-heading">
              <h3 id="article-reader-heading" className="font-display text-lg">原文读取</h3>
              <p data-testid="article-status" role="status" aria-live="polite" className="mt-2 text-sm text-muted">{articleStatus}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button data-testid="article-read-button" variant="outline" aria-busy={preview.isPending}
                  disabled={articlePending || !readerAvailable} onClick={() => preview.mutate()}>
                  {preview.isPending ? "读取中…" : "读取原文"}
                </Button>
                {articleState === "adopted" ? (
                  <Button data-testid="article-restore-button" variant="outline" disabled={articlePending || !versionValid}
                    onClick={() => restore.mutate()}>{restore.isPending ? "恢复中…" : "恢复此前正文"}</Button>
                ) : null}
              </div>
              {articleState === "candidate" && candidate ? (
                <section data-testid="article-candidate" aria-labelledby="article-candidate-heading" className="mt-5 min-w-0 rounded-md bg-raised p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 id="article-candidate-heading" className="font-display text-lg">正文候选</h4>
                    <Badge tone={candidateStale ? "warn" : "live"}>{candidateStale ? "需重新读取" : "待核对"}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted">读取时间：{formatDateTime(typeof item.extra.article_fetched_at === "string" ? item.extra.article_fetched_at : null)}</p>
                  {typeof item.extra.article_source_url === "string" && /^https:\/\//i.test(item.extra.article_source_url) ? (
                    <a href={item.extra.article_source_url} target="_blank" rel="noreferrer"
                      className="mt-2 block break-words text-sm text-muted hover:text-fg">候选来源：{item.extra.article_source_url}</a>
                  ) : null}
                  <div data-testid="article-candidate-text" className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">{candidate}</div>
                  <Button data-testid="article-adopt-button" className="mt-4" disabled={articlePending || !versionValid || candidateStale || !/^[a-f0-9]{64}$/.test(digest)}
                    onClick={() => adopt.mutate()}>{adopt.isPending ? "采用中…" : "采用正文"}</Button>
                </section>
              ) : null}
            </section>
          </article>
          <aside className="min-w-0 space-y-4 lg:col-span-2">
            <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
              <h3 className="font-display text-lg">知识层</h3>
              {analysis ? (
                <div className="mt-3 space-y-3 text-sm">
                  {detail.data?.analysisStale ? (
                    <p data-testid="analysis-stale" className="text-sm text-warn">正文已更新，以下为此前材料的分析；可手动重新分析。</p>
                  ) : null}
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
