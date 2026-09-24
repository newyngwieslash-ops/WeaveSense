import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/prd")({ component: PrdPage });

function PrdPage() {
  return (
    <AppShell title="产品规格" kicker="PRD · 织识 Loom">
      <article className="mx-auto max-w-3xl space-y-12 text-sm leading-relaxed text-muted">
        <header>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-faint">PRD / v1.2 / 2026-09-21</p>
          <h2 className="mt-2 font-display text-4xl text-fg tracking-tight">织识 · 行业媒体矩阵采集与知识引擎</h2>
          <p className="mt-4">
            把 Telegram、微信公众号、B 站、抖音、小红书、YouTube、西瓜与 RSS
            收进同一条增量管道；用户可自设关键字（词）定时收集；文本、图片、视频、文件、链接、作者、时间与浏览量归一化入库，再交给
            ASR / OCR / LLM，形成可检索的行业知识库。
          </p>
        </header>

        <Section title="1. 问题">
          <p>
            全能 Telegram Scraper 解决不了矩阵问题。各平台反爬、许可和接口完全不同。正确的产品不是「一个爬虫」，而是一条编排管道：调度、去重、存储不变，平台适配可替换。
          </p>
          <p className="mt-3">
            第二条缺口同样关键：只订阅账号会漏掉没有关注的信源。行业研究需要按<strong className="font-medium text-fg">关键词定时收集</strong>——设定「固态电池」「人形机器人」，每 5 / 10 / 30 分钟扫描新内容。
          </p>
        </Section>

        <Section title="2. 目标与非目标">
          <p className="text-fg">目标</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>100–1000 个频道 / 账号的定时增量扫描，只取新消息（last_external_id）。</li>
            <li>用户自设关键字（词），选择平台与间隔，自动检索并打标。</li>
            <li>统一字段：title / body / author / url / media_type / media_urls / views / published_at / platform。</li>
            <li>入库 PostgreSQL，媒体走对象存储；LLM 生成分析、简报、问答。</li>
          </ul>
          <p className="mt-4 text-fg">非目标</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>不捆绑闭源中转、不明许可的「一键全能爬虫」、官方 PyInstaller 二进制。</li>
            <li>不在无账号模式下保存个人隐私数据。</li>
            <li>不把 Telethon 会话、Cookie、FFmpeg 二进制塞进本预览环境。</li>
          </ul>
        </Section>

        <Section title="3. 用户与场景">
          <ul className="list-disc space-y-2 pl-5">
            <li>产业分析师：每天自动收齐公众号长文、B 站新稿、短视频口播，用关键词盯住 3–8 个赛道。</li>
            <li>内容团队：把矩阵当素材库，问「固态电池量产卡在哪」，得到带引用的回答。</li>
            <li>技术负责人：Go 编排 + 可替换 Python/浏览器 collector，换平台不换仓。</li>
          </ul>
        </Section>

        <Section title="4. 功能需求">
          <SpecTable
            rows={[
              ["FR-01", "信源接入", "按平台添加频道 / UP 主 / RSS，设定 5–1440 分钟间隔，启停。"],
              ["FR-02", "增量扫描", "只插入未见过的 external_id；记录 last_scanned_at 与错误。"],
              ["FR-03", "关键词雷达", "用户设定词（逗号/换行），选平台与间隔；到期自动检索。"],
              ["FR-04", "关键词打标", "新入库内容与已有库按词匹配，写入 matched_keywords。"],
              ["FR-05", "内容库", "按平台、形态、关键词过滤；详情展示归一化字段与原文链接。"],
              ["FR-06", "任务账本", "每次扫描一条 job：发现数、新增数、状态。"],
              ["FR-07", "LLM 分析", "用户触发：条目摘要、实体、洞察；不在页面加载时调用。"],
              ["FR-08", "简报 / 问答", "基于已采集条目生成行业简报；提问只引用库内材料。"],
              ["FR-09", "管道可视化", "采集 → 归一化 → 存储 → ASR/OCR → LLM → 知识库。"],
            ]}
          />
        </Section>

        <Section title="5. 关键词定时收集（核心）">
          <pre className="overflow-x-auto rounded-md bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
            {`用户设定
  固态电池，人形机器人，智能驾驶
  间隔 5 / 10 / 30 分钟
  平台：新闻RSS / B站 / YouTube / 已接入信源
        ↓
到期 tick
        ↓
Google News + HN + B站搜索 + YouTube
        +
已接入信源正文匹配
        ↓
external_id / URL 去重
        ↓
PostgreSQL.matched_keywords
        ↓
内容库过滤 / 知识问答`}
          </pre>
          <p className="mt-3">
            一个词就是一条监听器，不是一次性搜索。可以暂停、立刻收集、移除（条目保留）。生产环境可把检索后端换成 Telethon SearchGlobal、bilibili-cli、yt-dlp 搜索，接口不变。
          </p>
        </Section>

        <Section title="6. 采集架构">
          <pre className="overflow-x-auto rounded-md bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
            {`编排层（调度 / 任务 / 限流 / 存储 / API）
        │
   ┌────┼────────────┬────────────┐
  RSS  API/SDK    Browser     Keyword
   │      │          │            │
 WeWe  Telethon   Douyin     News RSS
 RSSHub bili-cli   XHS       B站搜索
 YT RSS  t.me/s    Xigua     本地打标
        │
     Normalizer
        │
 PostgreSQL + 对象存储
        │
   ASR / OCR / LLM
        │
   行业知识库`}
          </pre>
        </Section>

        <Section title="7. 平台矩阵与许可">
          <div className="overflow-x-auto rounded-lg bg-surface shadow-[var(--shadow-border)]">
            <table className="w-full min-w-[640px] text-left text-sm text-fg">
              <thead className="border-b border-border font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">平台</th>
                  <th className="px-4 py-3 font-medium">地基</th>
                  <th className="px-4 py-3 font-medium">许可</th>
                  <th className="px-4 py-3 font-medium">本部署</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {MATRIX.map((r) => (
                  <tr key={r[0]} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3 text-fg">{r[0]}</td>
                    <td className="px-4 py-3">{r[1]}</td>
                    <td className="px-4 py-3 font-mono text-xs">{r[2]}</td>
                    <td className="px-4 py-3">
                      <Badge tone={r[3] === "实采" ? "live" : "muted"}>{r[3]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            商业化不能只看仓库 LICENSE。运行时依赖、浏览器自动化、FFmpeg、第三方 API 与平台条款都要进 SBOM。yt-dlp 用 Unlicense 源码走独立进程，不要打官方 PyInstaller 包。
          </p>
        </Section>

        <Section title="8. 数据模型">
          <ul className="list-disc space-y-1 pl-5">
            <li>sources：平台、间隔、游标、适配器。</li>
            <li>keywords：短语、平台范围、间隔、命中计数。</li>
            <li>items：归一化内容 + matched_keywords + extra。</li>
            <li>jobs：每次扫描的账本（信源或关键词）。</li>
            <li>analyses / knowledge_notes：LLM 产出。</li>
          </ul>
        </Section>

        <Section title="9. 本部署实现状态">
          <p className="mb-3">
            核心流程已实现并发布，完整 PRD 尚未验收。以下区分代码实现与真实服务证据（截至 2026-09-21）：L0 已交付，L1 部分条件达成，L2 未达成；100–1000 信源持续运行仍待验证。
          </p>
          <SpecTable
            rows={[
              ["关键词定时收集", "已实现", "设定词、间隔、平台；到期扫描；立即收集。"],
              ["信源增量", "已实现", "external_id 去重、分页游标修复；后台唤醒 60 秒，实际延迟待持续验收。"],
              ["RSS / 新闻", "实采", "爱范儿、少数派真实 Feed 已验证；其他站点逐源验收。"],
              ["Telegram 公开频道", "实采", "已验证 t.me/s 公开预览；Telethon 账号尚未配置登录，健康不等于账号可采。"],
              ["B 站 / YouTube", "适配器", "YouTube 频道 RSS 已实测；B 站接口限流，当前封面不代表视频音轨。"],
              ["微信 / 抖音 / 小红书 / 西瓜", "适配器", "微信上次验收无正文，移出首版；其他平台依赖外部 Feed，未独立真实验收。"],
              ["文本 / 作者 / 时间 / 浏览量", "已实现", "归一化字段。"],
              ["图片 / 视频文件落盘", "已实现", "MinIO 节点；未连接时保留远程 URL，可稍后落盘。"],
              ["ASR / OCR", "已实现", "提取与幂等代码已实现，真实图片/音视频验收未完成；配置独立于同步模型。"],
              ["LLM 分析 / 简报 / 问答", "已实现", "用户触发；分析与库内问答已真实验证，简报真实验收未独立闭环；费用待对账。"],
            ]}
          />
        </Section>

        <Section title="10. 生产下一步">
          <ul className="list-disc space-y-1 pl-5">
            <li>Docker Compose：Postgres + MinIO + Telethon worker + 控制面。</li>
            <li>
              Telegram：<span className="font-mono text-xs">docker compose run --rm -it telethon python login.py</span>{" "}
              后，先验证少量公开频道的 GetHistory、去重与增量；100–1000 频道只完成离线突发评测，持续规模待验收。
            </li>
            <li>媒体：MinIO bucket loom；节点页可批量落盘。</li>
            <li>OCR / ASR：XAI_API_KEY；EXTRACT_AUTO=true 才在 tick 时自动提取。</li>
          </ul>
          <p className="mt-4">
            打开 <Link to="/nodes" className="text-fg underline-offset-2 hover:underline">生产节点</Link>
            看 Telethon / MinIO 是否在线；或去{" "}
            <Link to="/guide" className="text-fg underline-offset-2 hover:underline">使用指南</Link>
            。
          </p>
        </Section>
      </article>
    </AppShell>
  );
}

const MATRIX: [string, string, string, string][] = [
  ["Telegram", "Telethon / t.me/s", "MIT", "实采"],
  ["微信公众号", "WeWe RSS fork", "MIT", "适配器"],
  ["B 站", "UP 主 / 搜索接口、外部 Feed", "平台条款另核对", "限流待验收"],
  ["抖音", "外部 RSSHub / Feed", "由提供方核对", "未验收"],
  ["小红书", "外部 RSSHub / Feed", "由提供方核对", "未验收"],
  ["YouTube", "频道 RSS / 新闻索引", "平台条款另核对", "频道 RSS 实测"],
  ["西瓜", "外部 RSSHub / Feed", "由提供方核对", "未验收"],
  ["RSS", "RSSHub / 原生 feed", "MIT", "实采"],
  ["关键词雷达", "News RSS + 搜索 + 本地打标", "自研", "实采"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-display text-2xl text-fg tracking-tight">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SpecTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-surface shadow-[var(--shadow-border)]">
      <table className="w-full min-w-[560px] text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} className="border-b border-border/70 last:border-0">
              <td className="px-4 py-3 font-mono text-[11px] text-faint">{r[0]}</td>
              <td className="px-4 py-3 text-fg">{r[1]}</td>
              <td className="px-4 py-3 text-muted">{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
