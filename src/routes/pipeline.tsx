import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { PIPELINE_STAGES, PLATFORM_LIST } from "@/lib/platforms";

export const Route = createFileRoute("/pipeline")({ component: PipelinePage });

function PipelinePage() {
  return (
    <AppShell title="管道" kicker="Collector → Warehouse → LLM">
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        不要做成一堆独立脚本。编排层负责任务状态、重试、限流和存储；平台适配可以替换。某个平台挂了，只换一个
        collector，系统其余部分不动。关键词雷达与信源订阅走同一条归一化管道。
      </p>

      <ol className="mt-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PIPELINE_STAGES.map((stage, i) => (
          <li key={stage.id} className="rounded-lg bg-surface p-4 shadow-[var(--shadow-border)]">
            <p className="font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</p>
            <h2 className="mt-2 font-display text-xl tracking-tight">{stage.label}</h2>
            <p className="mt-1 text-sm text-muted">{stage.hint}</p>
          </li>
        ))}
      </ol>

      <section className="mt-10">
        <h2 className="font-display text-2xl tracking-tight">四路采集</h2>
        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          <Lane
            title="RSS"
            body="WeWe、RSSHub、YouTube 频道、新闻站点。天然适合 5/10/30 分钟增量。"
            items={["微信公众号", "RSSHub", "YouTube RSS", "行业站点"]}
          />
          <Lane
            title="API / SDK"
            body="Telegram 公开预览 / Telethon，B 站 UP 主列表，结构化元数据。"
            items={["Telethon MTProto", "t.me/s", "bilibili-cli", "bilibee 字幕"]}
          />
          <Lane
            title="Browser"
            body="抖音、小红书、西瓜等风控平台。Cookie + 浏览器回退，产出仍归一化。"
            items={["cmsjin/douyin", "xhs-downloader", "collector-xigua"]}
          />
          <Lane
            title="关键词"
            body="用户设定行业词，按间隔检索新闻 / B 站 / YouTube，并给已接入信源打标。"
            items={["Google News RSS", "HN", "B 站搜索", "本地命中"]}
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl tracking-tight">平台地基</h2>
        <div className="mt-4 overflow-x-auto rounded-lg bg-surface shadow-[var(--shadow-border)]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              <tr>
                <th className="px-4 py-3 font-medium">平台</th>
                <th className="px-4 py-3 font-medium">地基</th>
                <th className="px-4 py-3 font-medium">许可</th>
                <th className="px-4 py-3 font-medium">本部署</th>
              </tr>
            </thead>
            <tbody>
              {PLATFORM_LIST.map((p) => (
                <tr key={p.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-3">{p.name}</td>
                  <td className="px-4 py-3 text-muted">{p.foundation}</td>
                  <td className="px-4 py-3 font-mono text-xs">{p.license}</td>
                  <td className="px-4 py-3">
                    <Badge tone={p.live ? "live" : "muted"}>{p.live ? "实采" : "适配器 + 样本"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10 max-w-2xl">
        <h2 className="font-display text-2xl tracking-tight">存储与模型</h2>
        <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted">
          <li>PostgreSQL 保存信源、关键词、游标、条目、任务、分析。</li>
          <li>媒体文件走 MinIO（Docker 节点）。未连接时保留远程 URL，稍后落盘。</li>
          <li>ASR / OCR 按键调用 Grok STT 与视觉识别，结果写回正文。</li>
          <li>Telegram 在 Telethon 节点在线时走 GetHistory；否则回退 t.me/s。</li>
        </ul>
      </section>
    </AppShell>
  );
}

function Lane({ title, body, items }: { title: string; body: string; items: string[] }) {
  return (
    <div className="rounded-lg bg-surface p-5 shadow-[var(--shadow-border)]">
      <h3 className="font-display text-xl">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      <ul className="mt-4 space-y-1.5 font-mono text-[12px] text-faint">
        {items.map((it) => (
          <li key={it}>· {it}</li>
        ))}
      </ul>
    </div>
  );
}
