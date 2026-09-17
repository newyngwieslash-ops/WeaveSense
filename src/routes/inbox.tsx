import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Input, NativeSelect } from "@/components/ui/input";
import { PlatformChip } from "@/components/platform-chip";
import { Badge } from "@/components/ui/badge";
import { listItemsFn, listKeywordsFn } from "@/lib/server/fns";
import { MEDIA_TYPE_LABEL, PLATFORM_LIST, type MediaType, type PlatformId } from "@/lib/platforms";
import { formatCount, formatRelative, truncate } from "@/lib/format";
import { isPlatform } from "@/lib/platforms";

type InboxSearch = { platform?: string; q?: string; media?: string; keyword?: string };

export const Route = createFileRoute("/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    platform: typeof search.platform === "string" ? search.platform : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    media: typeof search.media === "string" ? search.media : undefined,
    keyword: typeof search.keyword === "string" ? search.keyword : undefined,
  }),
  component: InboxRoute,
});

function InboxRoute() {
  const hasDetail = useRouterState({ select: state => state.matches.some(match => match.routeId === "/inbox/$itemId") });
  return hasDetail ? <Outlet /> : <InboxPage />;
}

function InboxPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q ?? "");
  useEffect(() => setQuery(search.q ?? ""), [search.q]);
  const [composition, setComposition] = useState<string | null>(null);
  const updateQuery = (q: string) => {
    void navigate({ search: (previous) => ({ ...previous, q: q || undefined }), replace: true });
  };
  const items = useQuery({
    queryKey: ["items", search.platform, search.q, search.media, search.keyword],
    queryFn: () =>
      listItemsFn({
        data: {
          platform: search.platform,
          q: search.q,
          media: search.media,
          keyword: search.keyword,
        },
      }),
  });
  const keywords = useQuery({ queryKey: ["keywords"], queryFn: () => listKeywordsFn() });

  return (
    <AppShell title="内容" kicker="Normalized inbox">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={composition ?? query}
          aria-label="检索标题、正文、作者（输入即搜索）"
          placeholder="检索标题、正文、作者"
          className="sm:max-w-sm"
          onCompositionStart={(e) => setComposition(e.currentTarget.value)}
          onCompositionEnd={(e) => {
            setComposition(null);
            setQuery(e.currentTarget.value);
            updateQuery(e.currentTarget.value);
          }}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            if (composition !== null) setComposition(e.currentTarget.value);
            else updateQuery(e.currentTarget.value);
          }}
        />
        <NativeSelect
          value={search.platform ?? ""}
          className="sm:max-w-44"
          onChange={(e) =>
            void navigate({ search: { ...search, platform: e.target.value || undefined } })
          }
        >
          <option value="">全部平台</option>
          {PLATFORM_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={search.media ?? ""}
          className="sm:max-w-48"
          onChange={(e) =>
            void navigate({ search: { ...search, media: e.target.value || undefined } })
          }
        >
          <option value="">全部形态</option>
          {Object.entries(MEDIA_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </div>

      {(keywords.data ?? []).length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={`inline-flex h-8 items-center whitespace-nowrap rounded-full px-3 text-xs ${search.keyword ? "bg-raised text-muted" : "bg-accent text-accent-fg"}`}
            onClick={() => void navigate({ search: { ...search, keyword: undefined } })}
          >
            全部关键词
          </button>
          {(keywords.data ?? []).map((k) => {
            const on = search.keyword === k.phrase;
            return (
              <button
                key={k.id}
                type="button"
                className={`inline-flex h-8 items-center whitespace-nowrap rounded-full px-3 text-xs ${on ? "bg-accent text-accent-fg" : "bg-raised text-muted hover:text-fg"}`}
                onClick={() =>
                  void navigate({ search: { ...search, keyword: on ? undefined : k.phrase } })
                }
              >
                {k.phrase}
                <span className="ml-1 opacity-70">{k.hits}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-5 divide-y divide-border rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {items.isLoading ? (
          <p className="px-4 py-12 text-center text-sm text-muted">读取采集库…</p>
        ) : (items.data ?? []).length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted">没有匹配的条目</p>
        ) : (
          items.data?.map((item) => (
            <Link
              key={item.id}
              to="/inbox/$itemId"
              params={{ itemId: item.id }}
              search={search}
              className="block px-4 py-4 transition-colors hover:bg-raised/60"
            >
              <div className="flex flex-wrap items-center gap-2">
                <PlatformChip platform={isPlatform(item.platform) ? item.platform : "rss"} />
                <Badge>{MEDIA_TYPE_LABEL[item.media_type as MediaType] ?? item.media_type}</Badge>
                {item.pipeline_status === "analyzed" ? <Badge tone="live">已分析</Badge> : null}
                {item.matched_keywords.slice(0, 3).map((phrase) => (
                  <Badge key={phrase} tone="live">
                    {phrase}
                  </Badge>
                ))}
                <span className="font-mono text-[11px] text-faint">
                  {item.source_name} · {formatRelative(item.published_at ?? item.collected_at)}
                </span>
              </div>
              <h2 className="mt-2 text-[15px] leading-snug">{item.title}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{truncate(item.body, 160)}</p>
              <p className="mt-2 font-mono text-[11px] text-faint">
                {item.author ? `${item.author} · ` : ""}
                {item.views != null ? `浏览 ${formatCount(item.views)}` : "元数据已归一化"}
              </p>
            </Link>
          ))
        )}
      </div>
    </AppShell>
  );
}
