import { createFileRoute, Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/guide")({ component: GuidePage });

function GuidePage() {
  return (
    <AppShell
      title="使用指南"
      kicker="Handbook · 织识 Loom"
      action={
        <a href="/zhishi-loom-source.zip" download className={cn(buttonVariants({ size: "sm" }))}>
          <Download className="size-4" />
          <span className="sm:hidden">下载</span>
          <span className="hidden sm:inline">下载完整版</span>
        </a>
      }
    >
      <article className="mx-auto max-w-3xl space-y-12 text-sm leading-relaxed text-muted">
        <header>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-faint">Handbook / v1.5 / 2026-09</p>
          <h2 className="mt-2 font-display text-4xl tracking-tight text-fg">从打开到带走完整项目</h2>
          <p className="mt-4">
            织识是行业媒体矩阵的控制平面：订阅信源、设定关键词、定时增量入库，再交给 LLM 做分析、简报和问答。本页就是最新完整版说明书。右上角「下载完整版」得到源码包；预览里也可以直接用。
          </p>
        </header>

        <a
          href="/zhishi-loom-source.zip"
          download
          className="flex flex-col gap-3 border border-white/15 bg-surface px-5 py-5 transition-colors hover:border-white/30 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Latest package</p>
            <p className="mt-1 font-display text-2xl text-fg">zhishi-loom-source.zip</p>
            <p className="mt-1 text-sm text-muted">v1.5 · 控制面、Telethon 节点、Docker Compose、迁移与本指南。不含 node_modules。</p>
          </div>
          <span className={cn(buttonVariants({ size: "sm" }), "shrink-0")}>
            <Download className="size-4" />
            下载
          </span>
        </a>

        <Section title="1. 三种使用方式">
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              <strong className="font-medium text-fg">就在预览里用</strong>
              ——左侧导航即完整产品。示例信源会自动接入，适合先验证流程。没有 Docker 时 Telegram 走公开网页预览，媒体保留远程链接，ASR / OCR 仍可按键调用。
            </li>
            <li>
              <strong className="font-medium text-fg">下载完整版到自己的机器</strong>
              ——点本页「下载完整版」，解压后按第 8、9 节。生产扫 100–1000 个 Telegram 频道必须走 Docker。
            </li>
            <li>
              <strong className="font-medium text-fg">Remix</strong>
              ——预览角落的 Remix / 用 Grok 创作，复制一份属于你的托管应用。
            </li>
          </ol>
        </Section>

        <Section title="2. 五分钟上手（预览）">
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              打开
              <Link to="/" className="mx-1 text-fg underline-offset-2 hover:underline">
                总览
              </Link>
              。首页是线框空间指挥台。首次进入会自动接入示例信源并扫描到期任务。底边四个格子有数字即已就绪。
            </li>
            <li>
              点右上角
              <strong className="font-medium text-fg">扫描到期</strong>
              。只拉取比游标更新的消息，不会整库重爬。
            </li>
            <li>
              去
              <Link to="/keywords" className="mx-1 text-fg underline-offset-2 hover:underline">
                关键词
              </Link>
              ，粘贴行业词（例如「固态电池，人形机器人」），选间隔与平台。提交后立刻做第一次收集。
            </li>
            <li>
              在
              <Link to="/inbox" className="mx-1 text-fg underline-offset-2 hover:underline">
                内容
              </Link>
              按平台、形态或关键词过滤。点进一条看原文、作者、时间、浏览量；可做 OCR / ASR / LLM 分析。
            </li>
            <li>
              打开
              <Link to="/knowledge" className="mx-1 text-fg underline-offset-2 hover:underline">
                知识库
              </Link>
              提问或生成今日简报。模型只在你按键时调用。
            </li>
          </ol>
        </Section>

        <Section title="3. 页面地图">
          <NavTable
            rows={[
              { to: "/", label: "总览", blurb: "线框指挥台、矩阵房间、关键词雷达、最新入库。" },
              { to: "/keywords", label: "关键词", blurb: "设定行业词，按 5/10/30 分钟检索并打标。" },
              { to: "/sources", label: "信源", blurb: "接入频道；Telegram 可一次粘贴最多 1000 个。" },
              { to: "/inbox", label: "内容", blurb: "归一化条目。过滤、检索、OCR/ASR、LLM。" },
              { to: "/knowledge", label: "知识库", blurb: "简报、笔记、基于库内材料的问答。" },
              { to: "/jobs", label: "任务", blurb: "每次增量扫描的账本：发现数、新增、错误。" },
              { to: "/nodes", label: "节点", blurb: "Telethon / MinIO / ASR 是否在线，以及落盘按钮。" },
              { to: "/pipeline", label: "管道", blurb: "采集 → 归一化 → 存储 → ASR/OCR → LLM。" },
              { to: "/prd", label: "规格", blurb: "完整 PRD：目标、许可、数据模型、生产路线。" },
            ]}
          />
        </Section>

        <Section title="4. 接入信源">
          <p>
            在信源页点「接入」。每个平台一个 collector，编排层负责间隔、重试和
            <span className="font-mono text-xs text-fg"> last_external_id </span>
            游标。
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong className="font-medium text-fg">RSS / Atom</strong>
              ：填 Feed URL。36氪、量子位、HN、Google News 这类公开源可直接实采。
            </li>
            <li>
              <strong className="font-medium text-fg">Telegram</strong>
              ：用资料页上的英文用户名，不要用聊天列表里的中文名。可填
              <span className="font-mono text-xs text-fg"> chqq888888</span>、
              <span className="font-mono text-xs text-fg">@chqq888888</span> 或
              <span className="font-mono text-xs text-fg"> https://t.me/chqq888888</span>
              。批量框每行一个、最多 1000 个。RSS 栏留空。Docker 里 Telethon 已登录时走 GetHistory
              增量；未登录才回退 t.me/s。已登录后失败会记为错误，不再悄悄改走网页。不要只填
              <span className="font-mono text-xs text-fg">t.me</span>
              ，旧解析会把它吃成错误用户名 tme。
            </li>
            <li>
              <strong className="font-medium text-fg">微信公众号</strong>
              ：把 WeWe RSS 或任意 Atom 地址填进「RSS / WeWe」栏。
            </li>
            <li>
              <strong className="font-medium text-fg">B 站 / YouTube</strong>
              ：分别填 UP mid、Channel ID。接口被风控时记到任务错误，适配器仍保留。
              B 站的视频媒体只有封面图（不是音轨）；YouTube 走的是频道 RSS，不是全站搜索。
            </li>
            <li>
              <strong className="font-medium text-fg">抖音 / 小红书 / 西瓜</strong>
              ：没有内置全站检索。有 RSSHub 或自建 collector 时，把 URL 填进 RSS 栏即走同一条管道；
              否则这些平台在关键词检索里不会被查询。
            </li>
          </ul>
          <p className="mt-3">
            间隔建议：快讯 5 分钟，专栏 30 或 60 分钟，深度长文每天一次。停用信源不会删除已入库内容。
            B 站接口有风控：被限流时任务会标记为限流原因（不是普通失败），建议间隔不低于 6 小时。
          </p>
          <p className="mt-3">
            Telegram 接入后点该行「扫描」，到任务页看徽章：绿色 Telethon 且新增大于 0 是账号通道；Telethon
            且 0/0、状态 ok 是已经追上；黄色 t.me/s 且约 20/0 是网页预览。没有公开用户名的群、官方登录通知不要加。
          </p>
          <p className="mt-3">
            Telegram 接入后点该行「扫描」，到任务页看徽章：绿色 Telethon 且新增大于 0 是账号通道；Telethon
            且 0/0、状态 ok 是已经追上；黄色 t.me/s 且约 20/0 是网页预览。没有公开用户名的群、官方登录通知不要加。
          </p>
        </Section>

        <Section title="5. 关键词雷达">
          <p>一个词是一条监听器，不是一次性搜索。到期后会：</p>
          <pre className="mt-3 overflow-x-auto bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
            {`设定词 + 间隔 + 平台
        ↓
新闻 RSS（Google News 中英文）/ HN / B站搜索 / YouTube 新闻索引
        +
已接入信源正文匹配（标「信源」的范围只做这一步，不联网）
        ↓
URL / external_id 去重
        ↓
items.matched_keywords
        ↓
内容库过滤 / 知识问答`}
          </pre>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>逗号、顿号或换行分隔，一次最多 20 个词，每词 2–40 字。</li>
            <li>「检索」平台会去公开搜索源拉新条目；「信源」平台只给已入库内容打标。</li>
            <li>「立即收集」不等到期；「暂停」停调度；「移除」只停监听，条目保留。</li>
            <li>点词名可跳到内容库，只看该词命中。</li>
          </ul>
        </Section>

        <Section title="6. 内容、OCR / ASR、知识库">
          <p>
            每条内容归一化为：标题、正文、作者、链接、形态（文章 / 文本 / 图 / 视频 / 文件 /
            链接）、媒体 URL、浏览量、发布时间、平台。详情页可以：
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              <strong className="font-medium text-fg">LLM 分析</strong> — 摘要、主题、实体、洞察。
            </li>
            <li>
              <strong className="font-medium text-fg">OCR / ASR</strong> — 图片走视觉识别，音视频走语音转写，结果写回正文。
            </li>
          </ul>
          <p className="mt-3">
            知识库只引用已采集材料。问「固态电池量产卡在哪」会检索库内条目并带引用。「生成今日简报」把近 24
            小时入库编成笔记。没有密钥时会明确提示，不会伪造回答。
          </p>
        </Section>

        <Section title="7. 本版能力">
          <div className="overflow-x-auto bg-surface shadow-[var(--shadow-border)]">
            <table className="w-full min-w-[560px] text-left text-sm text-fg">
              <thead className="border-b border-border font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">能力</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {STATUS.map((r) => (
                  <tr key={r[0]} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3 text-fg">{r[0]}</td>
                    <td className="px-4 py-3">
                      <Badge tone={r[1] === "实采" || r[1] === "已实现" ? "live" : "muted"}>{r[1]}</Badge>
                    </td>
                    <td className="px-4 py-3">{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            打开
            <Link to="/nodes" className="mx-1 text-fg underline-offset-2 hover:underline">
              生产节点
            </Link>
            看 Telethon / MinIO / ASR 是否在线。完整规格见
            <Link to="/prd" className="mx-1 text-fg underline-offset-2 hover:underline">
              产品规格
            </Link>
            。
          </p>
        </Section>

        <Section title="8. 解压后本地开发">
          <p>需要 Node.js 22 与 npm。包内不含依赖，第一次要安装。</p>
          <pre className="mt-3 overflow-x-auto bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
            {`unzip zhishi-loom-source.zip
cd zhishi-loom
npm install
npm run dev`}
          </pre>
          <p className="mt-3">
            没有 Postgres 时自动用内嵌数据库。可选变量写在环境里，不要提交密钥。模板见包内{" "}
            <span className="font-mono text-xs text-fg">env.example</span>。
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              <span className="font-mono text-xs text-fg">XAI_API_KEY</span> — LLM 分析、简报、问答、OCR、ASR。
            </li>
            <li>
              <span className="font-mono text-xs text-fg">DATABASE_URL</span> — Postgres。未设则内嵌库。
            </li>
            <li>
              <span className="font-mono text-xs text-fg">npm run build</span> /{" "}
              <span className="font-mono text-xs text-fg">npm run typecheck</span> /{" "}
              <span className="font-mono text-xs text-fg">npm run db:migrate</span>
            </li>
          </ul>
        </Section>

        <Section title="9. Docker 生产（推荐）">
          <p>
            这一步才会真正启用 Telethon 扫 100–1000 频道、MinIO 落盘。先到{" "}
            <a href="https://my.telegram.org" className="text-fg underline-offset-2 hover:underline">
              my.telegram.org
            </a>{" "}
            申请 api_id / api_hash。
          </p>
          <pre className="mt-3 overflow-x-auto bg-raised p-4 font-mono text-[12px] leading-6 text-fg">
            {`# 1. 把密钥放进环境（不要写进仓库）
export TELEGRAM_API_ID=你的数字 id
export TELEGRAM_API_HASH=你的 hash
export XAI_API_KEY=可选，开 OCR/ASR/LLM

# 2. 交互登录一次（手机号验证码）
docker compose run --rm -it telethon python login.py

# 3. 启动 Postgres + MinIO + Telethon + 控制面
docker compose up --build`}
          </pre>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>控制面对外服务；MinIO 控制台在 9001。会话写在 volume，不必每次登录。</li>
            <li>登录前 Telegram 信源自动回退公开网页预览，控制面照常可开。</li>
            <li>
              信源页选 Telegram，把频道用户名每行一个贴进去（最多 1000）。间隔建议 10 分钟。每轮默认扫 20 路到期任务，可用{" "}
              <span className="font-mono text-xs text-fg">TICK_LIMIT</span> 调整。
            </li>
            <li>
              「节点」页应看到 Telethon 已登录、MinIO 在线。点「媒体落盘」把远程文件写入 bucket{" "}
              <span className="font-mono text-xs">loom</span>。
            </li>
            <li>
              OCR / ASR 默认按键触发。只有设置{" "}
              <span className="font-mono text-xs text-fg">EXTRACT_AUTO=true</span> 才会在扫描时自动提取（消耗额度）。
            </li>
          </ul>
        </Section>

        <Section title="10. 日常操作顺序">
          <ol className="list-decimal space-y-2 pl-5">
            <li>关键词页设定行业词，确认立刻收集有命中。</li>
            <li>信源页接入 RSS / Telegram 频道。</li>
            <li>总览点「扫描到期」，或等页面可见时约每 2 分钟自动 tick。</li>
            <li>内容库过滤查看；重要条目做分析或 OCR/ASR。</li>
            <li>知识库生成今日简报，或直接提问。</li>
            <li>任务页核对失败原因（风控、FloodWait、未登录）。</li>
            <li>节点页确认生产组件；需要时点媒体落盘。</li>
          </ol>
        </Section>

        <Section title="11. 常见问题">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="font-medium text-fg">节点页 Telethon / MinIO 显示未配置</strong>
              ——预览里正常。本机请按第 9 节启动 Docker。
            </li>
            <li>
              <strong className="font-medium text-fg">Telegram 任务报未登录</strong>
              ——再跑一次 login.py，确认会话写进 volume。重建 Telethon 时要用带 TELEGRAM_API_ID / HASH 的项目根目录 .env，空值会冲掉凭据。
            </li>
            <li>
              <strong className="font-medium text-fg">信源变成 tme，或报 JSON / 500</strong>
              ——把 t.me/用户名 整段当成了域名。应填用户名本身或完整 https://t.me/用户名。停用错误行后重新接入。
            </li>
            <li>
              <strong className="font-medium text-fg">任务 20/0 且徽章是 t.me/s</strong>
              ——网页预览。先看节点页是否已登录。
            </li>
            <li>
              <strong className="font-medium text-fg">任务 0/0、徽章 Telethon、状态 ok</strong>
              ——正常，已经追上。
            </li>
            <li>
              <strong className="font-medium text-fg">FloodWait</strong>
              ——节点会自动推迟，任务记为 Telethon 错误，不会改走网页。把间隔调到 10/30 分钟，或降低并发。
            </li>
            <li>
              <strong className="font-medium text-fg">OCR / ASR 提示没有密钥</strong>
              ——设置 XAI_API_KEY。模型只在按键时调用。
            </li>
            <li>
              <strong className="font-medium text-fg">微信 / 抖音 / 小红书没内容</strong>
              ——它们是适配器。把 WeWe 或 RSSHub 地址填进信源的 RSS 栏。
            </li>
            <li>
              <strong className="font-medium text-fg">批量频道没全部扫到</strong>
              ——每轮只扫到期的前 TICK_LIMIT 路，下一轮继续。
            </li>
          </ul>
        </Section>

        <Section title="12. 合规与许可">
          <p>
            仓库与核心依赖优先 MIT / Apache-2.0 / BSD / Unlicense。商业化不能只看项目 LICENSE：还要核对运行时依赖、浏览器自动化、FFmpeg、第三方
            API 和各平台服务条款。只采集你有权访问的公开源；不要把 Cookie、Telethon
            会话或个人隐私写进无账号模式的数据库。
          </p>
          <p className="mt-4">
            下一步：
            <a href="/zhishi-loom-source.zip" download className="mx-1 text-fg underline-offset-2 hover:underline">
              下载完整版
            </a>
            ，或去
            <Link to="/keywords" className="mx-1 text-fg underline-offset-2 hover:underline">
              设定关键词
            </Link>
            ，或回
            <Link to="/" className="mx-1 text-fg underline-offset-2 hover:underline">
              总览
            </Link>
            。
          </p>
        </Section>
      </article>
    </AppShell>
  );
}

const STATUS: [string, string, string][] = [
  ["关键词定时收集", "已实现", "设定、间隔、立即收集、打标"],
  ["信源增量", "已实现", "external_id 去重，5/10/30 分钟"],
  ["RSS / 新闻", "实采", "公开 Feed"],
  ["Telegram 公开频道", "实采", "Docker Telethon GetHistory；未连接回退 t.me/s"],
  ["B 站 / YouTube", "适配器", "搜索与频道 RSS 可用，可能被风控"],
  ["微信 / 抖音 / 小红书 / 西瓜", "适配器", "填 WeWe / RSSHub 即实采"],
  ["图片 / 视频文件落盘", "已实现", "MinIO；未连接时保留远程 URL"],
  ["ASR / OCR", "已实现", "按键触发 Grok 视觉 / STT"],
  ["LLM 分析 / 简报 / 问答", "已实现", "按键触发，不预热调用"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-display text-2xl tracking-tight text-fg">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function NavTable({
  rows,
}: {
  rows: {
    to: "/" | "/keywords" | "/sources" | "/inbox" | "/knowledge" | "/jobs" | "/nodes" | "/pipeline" | "/prd";
    label: string;
    blurb: string;
  }[];
}) {
  return (
    <div className="overflow-x-auto bg-surface shadow-[var(--shadow-border)]">
      <table className="w-full min-w-[520px] text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.to} className="border-b border-border/70 last:border-0">
              <td className="px-4 py-3">
                <Link to={r.to} className="text-fg hover:underline">
                  {r.label}
                </Link>
              </td>
              <td className="px-4 py-3 font-mono text-[11px] text-faint">{r.to}</td>
              <td className="px-4 py-3 text-muted">{r.blurb}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
