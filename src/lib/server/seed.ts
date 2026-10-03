import { getSql } from "@/lib/db";
import { itemMatchesPhrase, RADAR_SOURCE_ID } from "@/lib/keyword";
import type { MediaType, PlatformId } from "@/lib/platforms";

type SeedSource = {
  id: string;
  platform: PlatformId;
  name: string;
  handle: string;
  url: string;
  feed_url: string;
  interval_minutes: number;
  adapter: string;
  notes: string;
  live: boolean;
};

type SeedItem = {
  source_id: string;
  platform: PlatformId;
  external_id: string;
  title: string;
  body: string;
  author: string;
  url: string;
  media_type: MediaType;
  hours_ago: number;
  views?: number;
};

type SeedKeyword = {
  id: string;
  phrase: string;
  interval_minutes: number;
  notes: string;
  platforms: PlatformId[];
};

export const SOURCES: SeedSource[] = [
  {
    id: RADAR_SOURCE_ID,
    platform: "rss",
    name: "关键词雷达",
    handle: "keyword-radar",
    url: "",
    feed_url: "",
    interval_minutes: 10,
    adapter: "rss",
    notes: "关键词定时检索的归一化入口",
    live: true,
  },
  {
    id: "src_rss_36kr",
    platform: "rss",
    name: "36氪",
    handle: "36kr",
    url: "https://36kr.com",
    feed_url: "https://36kr.com/feed",
    interval_minutes: 10,
    adapter: "rss",
    notes: "科技商业快讯 · 原生 RSS",
    live: true,
  },
  {
    id: "src_rss_qbitai",
    platform: "rss",
    name: "量子位",
    handle: "qbitai",
    url: "https://www.qbitai.com",
    feed_url: "https://www.qbitai.com/feed",
    interval_minutes: 10,
    adapter: "rss",
    notes: "人工智能一线",
    live: true,
  },
  {
    id: "src_rss_ifanr",
    platform: "rss",
    name: "爱范儿",
    handle: "ifanr",
    url: "https://www.ifanr.com",
    feed_url: "https://www.ifanr.com/feed",
    interval_minutes: 30,
    adapter: "rss",
    notes: "消费科技与数字生活",
    live: true,
  },
  {
    id: "src_rss_sspai",
    platform: "rss",
    name: "少数派",
    handle: "sspai",
    url: "https://sspai.com",
    feed_url: "https://sspai.com/feed",
    interval_minutes: 30,
    adapter: "rss",
    notes: "效率工具与数字工作流",
    live: true,
  },
  {
    id: "src_rss_solidot",
    platform: "rss",
    name: "Solidot",
    handle: "solidot",
    url: "https://www.solidot.org",
    feed_url: "https://www.solidot.org/index.rss",
    interval_minutes: 10,
    adapter: "rss",
    notes: "科学与开源速递",
    live: true,
  },
  {
    id: "src_rss_tc",
    platform: "rss",
    name: "TechCrunch",
    handle: "techcrunch",
    url: "https://techcrunch.com",
    feed_url: "https://techcrunch.com/feed/",
    interval_minutes: 15,
    adapter: "rss",
    notes: "全球创投与产品",
    live: true,
  },
  {
    id: "src_rss_verge",
    platform: "rss",
    name: "The Verge",
    handle: "theverge",
    url: "https://www.theverge.com",
    feed_url: "https://www.theverge.com/rss/index.xml",
    interval_minutes: 20,
    adapter: "rss",
    notes: "消费电子与平台",
    live: true,
  },
  {
    id: "src_rss_bbc",
    platform: "rss",
    name: "BBC Technology",
    handle: "bbc-tech",
    url: "https://www.bbc.com/news/technology",
    feed_url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
    interval_minutes: 30,
    adapter: "rss",
    notes: "国际科技新闻",
    live: true,
  },
  {
    id: "src_rss_hn",
    platform: "rss",
    name: "Hacker News",
    handle: "hn",
    url: "https://news.ycombinator.com",
    feed_url: "https://hnrss.org/frontpage",
    interval_minutes: 10,
    adapter: "rss",
    notes: "工程师舆论场",
    live: true,
  },
  {
    id: "src_tg_telegram",
    platform: "telegram",
    name: "Telegram News",
    handle: "telegram",
    url: "https://t.me/s/telegram",
    feed_url: "",
    interval_minutes: 10,
    adapter: "telegram_web",
    notes: "公开频道网页预览 · 生产可换 Telethon GetHistory",
    live: true,
  },
  {
    id: "src_tg_durov",
    platform: "telegram",
    name: "Durov's Channel",
    handle: "durov",
    url: "https://t.me/s/durov",
    feed_url: "",
    interval_minutes: 30,
    adapter: "telegram_web",
    notes: "公开频道 · last_message_id 增量",
    live: true,
  },
  {
    id: "src_wechat_latepost",
    platform: "wechat",
    name: "晚点 LatePost",
    handle: "latepost",
    url: "https://www.latepost.com",
    feed_url: "",
    interval_minutes: 60,
    adapter: "rss",
    notes: "接入 WeWe RSS 后改为真实公众号全文",
    live: false,
  },
  {
    id: "src_wechat_jiqizhixin",
    platform: "wechat",
    name: "机器之心",
    handle: "jiqizhixin",
    url: "https://www.jiqizhixin.com",
    feed_url: "",
    interval_minutes: 60,
    adapter: "rss",
    notes: "AI 产业深度 · WeWe MIT fork",
    live: false,
  },
  {
    id: "src_bili_hetongxue",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    name: "老师好我叫何同学",
    handle: "163637592",
    url: "https://space.bilibili.com/163637592",
    feed_url: "",
    interval_minutes: 360,
    adapter: "bilibili",
    notes: "UP 主视频增量 · 生产接 bilibili-cli",
    live: false,
  },
  {
    id: "src_bili_paperclip",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    name: "回形针PaperClip",
    handle: "25876945",
    url: "https://space.bilibili.com/25876945",
    feed_url: "",
    interval_minutes: 360,
    adapter: "bilibili",
    notes: "知识影像 · 字幕可接 bilibee",
    live: false,
  },
  {
    id: "src_yt_tmp",
    platform: "youtube",
    name: "Two Minute Papers",
    handle: "UCCezIgC97PvUuR4sLbwZ0SA",
    url: "https://www.youtube.com/channel/UCCezIgC97PvUuR4sLbwZ0SA",
    feed_url: "",
    interval_minutes: 60,
    adapter: "youtube",
    notes: "频道 RSS + yt-dlp 独立进程下载",
    live: false,
  },
  {
    id: "src_yt_yc",
    platform: "youtube",
    name: "Y Combinator",
    handle: "UCcefcZRL2oaA_uLGemUF-yw",
    url: "https://www.youtube.com/channel/UCcefcZRL2oaA_uLGemUF-yw",
    feed_url: "",
    interval_minutes: 180,
    adapter: "youtube",
    notes: "创投访谈 · Unlicense 采集层",
    live: false,
  },
  {
    id: "src_dy_tech",
    platform: "douyin",
    name: "硬核科技现场",
    handle: "tech-floor",
    url: "https://www.douyin.com",
    feed_url: "",
    interval_minutes: 30,
    adapter: "rsshub",
    notes: "指定账号每日扫描 · cmsjin/douyin",
    live: false,
  },
  {
    id: "src_xhs_lab",
    platform: "xhs",
    name: "行业观察笔记",
    handle: "industry-notes",
    url: "https://www.xiaohongshu.com",
    feed_url: "",
    interval_minutes: 30,
    adapter: "rsshub",
    notes: "笔记+图片+视频 · xhs-downloader",
    live: false,
  },
  {
    id: "src_xigua_auto",
    platform: "xigua",
    name: "智驾车间",
    handle: "auto-lab",
    url: "https://www.ixigua.com",
    feed_url: "",
    interval_minutes: 60,
    adapter: "rsshub",
    notes: "无稳定 MIT 专用爬虫，自研 collector-xigua",
    live: false,
  },
];

const KEYWORDS: SeedKeyword[] = [
  {
    id: "kw_solid_battery",
    phrase: "固态电池",
    interval_minutes: 30,
    notes: "材料、量产、车企供应链",
    platforms: ["rss", "bilibili", "youtube", "wechat"],
  },
  {
    id: "kw_humanoid",
    phrase: "人形机器人",
    interval_minutes: 30,
    notes: "本体、工厂落地、供应链",
    platforms: ["rss", "bilibili", "youtube"],
  },
  {
    id: "kw_llm",
    phrase: "大模型",
    interval_minutes: 10,
    notes: "开源许可、推理成本、行业落地",
    platforms: ["rss", "bilibili", "youtube", "wechat"],
  },
  {
    id: "kw_adas",
    phrase: "智能驾驶",
    interval_minutes: 30,
    notes: "NOA、智驾、车端模型",
    platforms: ["rss", "bilibili", "douyin", "xigua"],
  },
  {
    id: "kw_packaging",
    phrase: "先进封装",
    interval_minutes: 60,
    notes: "CoWoS、OSAT、材料认证",
    platforms: ["rss", "wechat", "xhs"],
  },
];

const ITEMS: SeedItem[] = [
  {
    source_id: "src_wechat_latepost",
    platform: "wechat",
    external_id: "wc-late-001",
    title: "宁德时代的下一块电池，不再只卖给车企",
    body: "储能、船舶、数据中心备电正在改写宁德时代的客户结构。文章梳理其从「车企供应商」转向「能源基础设施公司」的路径，以及这对整车价格战的含义。固态电池中试线也在同期扩产。",
    author: "晚点 LatePost",
    url: "https://www.latepost.com",
    media_type: "article",
    hours_ago: 4,
    views: 186000,
  },
  {
    source_id: "src_wechat_latepost",
    platform: "wechat",
    external_id: "wc-late-002",
    title: "字节如何把抖音做成一套全球广告操作系统",
    body: "从推荐、素材生产到投放闭环，抖音的商业化不再只是国内信息流。对行业媒体采集来说，这意味着短视频平台正在成为可检索的商业情报源。",
    author: "晚点 LatePost",
    url: "https://www.latepost.com",
    media_type: "article",
    hours_ago: 18,
    views: 142000,
  },
  {
    source_id: "src_wechat_latepost",
    platform: "wechat",
    external_id: "wc-late-003",
    title: "一家中国机器人公司的工厂夜班",
    body: "当人形机器人还在演示厅跳舞，这家公司已经把机械臂、视觉和排程软件卖进了三班倒的工厂。真正的门槛不是模型，是产线节拍。",
    author: "晚点 LatePost",
    url: "https://www.latepost.com",
    media_type: "article",
    hours_ago: 30,
    views: 98000,
  },
  {
    source_id: "src_wechat_jiqizhixin",
    platform: "wechat",
    external_id: "wc-jqzx-001",
    title: "开源模型的 2026 分水岭：许可、数据与推理成本",
    body: "MIT / Apache 与「看似开放」的条款正在分流企业采购。对要做行业知识库的团队，许可证清单位于模型榜单之前。大模型采购首先看许可。",
    author: "机器之心",
    url: "https://www.jiqizhixin.com",
    media_type: "article",
    hours_ago: 7,
    views: 76000,
  },
  {
    source_id: "src_wechat_jiqizhixin",
    platform: "wechat",
    external_id: "wc-jqzx-002",
    title: "多模态检索正在重写行业知识库",
    body: "ASR、OCR 与文本向量不再是三条管道，而是同一条归一化流水线。能把视频、图片和公众号正文映射到同一套实体上的系统，才会形成复利。",
    author: "机器之心",
    url: "https://www.jiqizhixin.com",
    media_type: "article",
    hours_ago: 26,
    views: 54000,
  },
  {
    source_id: "src_bili_hetongxue",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    external_id: "BV1SEED01",
    title: "我做了一个真正能跑的媒体采集矩阵",
    body: "从 Telegram 频道、公众号 RSS 到 B 站 UP 主，用定时增量而不是一次性爬全站。重点是 last_message_id、去重和可替换的 collector。",
    author: "老师好我叫何同学",
    url: "https://www.bilibili.com/video/BV1SEED01",
    media_type: "video",
    hours_ago: 12,
    views: 1204000,
  },
  {
    source_id: "src_bili_hetongxue",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    external_id: "BV1SEED02",
    title: "为什么我不推荐「全能 Telegram Scraper」",
    body: "MTProto client 和 crawler 是两件事。Telethon 负责会话与历史消息，调度、存储、重试应该在你自己的编排层。",
    author: "老师好我叫何同学",
    url: "https://www.bilibili.com/video/BV1SEED02",
    media_type: "video",
    hours_ago: 40,
    views: 860000,
  },
  {
    source_id: "src_bili_paperclip",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    external_id: "BV1SEED03",
    title: "一条视频如何进入行业知识图谱",
    body: "字幕、关键帧 OCR、实体对齐、时间戳切片。没有增量游标的采集，后面的 NLP 都在重复劳动。",
    author: "回形针PaperClip",
    url: "https://www.bilibili.com/video/BV1SEED03",
    media_type: "video",
    hours_ago: 16,
    views: 640000,
  },
  {
    source_id: "src_bili_paperclip",
    // T21: Bilibili throttles this API (-799) even at low volume, so its default
    // interval is doubled versus other platforms. Throttling is also now
    // recognised (see collectors/index.ts) rather than retried at full speed.
    platform: "bilibili",
    external_id: "BV1SEED04",
    title: "固态电池量产卡点：电解质、界面与良率",
    body: "把一篇论文、一场发布会和三条短视频对齐到同一组材料参数，是行业知识库该做的事。固态电池的窗口期正在被良率改写。",
    author: "回形针PaperClip",
    url: "https://www.bilibili.com/video/BV1SEED04",
    media_type: "video",
    hours_ago: 52,
    views: 510000,
  },
  {
    source_id: "src_yt_tmp",
    platform: "youtube",
    external_id: "yt-tmp-001",
    title: "Why industry knowledge graphs beat generic RAG",
    body: "Generic RAG retrieves chunks. An industry graph retrieves claims, entities and counter-evidence across Telegram, journals and video transcripts.",
    author: "Two Minute Papers",
    url: "https://www.youtube.com/watch?v=yt-tmp-001",
    media_type: "video",
    hours_ago: 9,
    views: 220000,
  },
  {
    source_id: "src_yt_tmp",
    platform: "youtube",
    external_id: "yt-tmp-002",
    title: "Incremental crawlers for 1000 media channels",
    body: "Scan every 5/10/30 minutes. Store last_message_id. Never refetch history. The unglamorous cursor is the whole system.",
    author: "Two Minute Papers",
    url: "https://www.youtube.com/watch?v=yt-tmp-002",
    media_type: "video",
    hours_ago: 33,
    views: 180000,
  },
  {
    source_id: "src_yt_yc",
    platform: "youtube",
    external_id: "yt-yc-001",
    title: "The media matrix as a product, not a pile of scripts",
    body: "Go orchestrates schedule, retries, quotas. Python workers speak Telethon, Douyin and XHS. Swap a collector, keep the warehouse.",
    author: "Y Combinator",
    url: "https://www.youtube.com/watch?v=yt-yc-001",
    media_type: "video",
    hours_ago: 20,
    views: 96000,
  },
  {
    source_id: "src_yt_yc",
    platform: "youtube",
    external_id: "yt-yc-002",
    title: "Licenses that survive a commercial SaaS audit",
    body: "MIT on the repo is not enough. Inventory runtime deps, FFmpeg, browser automation and the platform ToS before you ship.",
    author: "Y Combinator",
    url: "https://www.youtube.com/watch?v=yt-yc-002",
    media_type: "video",
    hours_ago: 44,
    views: 74000,
  },
  {
    source_id: "src_dy_tech",
    platform: "douyin",
    external_id: "dy-001",
    title: "上海车展的智能驾驶对垒（现场）",
    body: "三家新势力把城市 NOA 的接管次数摊开讲。短视频里的口播密度很高，适合 ASR 后进入知识库。智能驾驶正在从演示变成可比较的指标。",
    author: "硬核科技现场",
    url: "https://www.douyin.com",
    media_type: "video",
    hours_ago: 6,
    views: 2300000,
  },
  {
    source_id: "src_dy_tech",
    platform: "douyin",
    external_id: "dy-002",
    title: "3 分钟看懂固态电池量产卡点",
    body: "口播覆盖电解质窗口、锂金属负极和干法电极。建议结合公众号长文做交叉验证。固态电池并不是一个发布会名词。",
    author: "硬核科技现场",
    url: "https://www.douyin.com",
    media_type: "video",
    hours_ago: 14,
    views: 980000,
  },
  {
    source_id: "src_dy_tech",
    platform: "douyin",
    external_id: "dy-003",
    title: "拆招股书：增长是产品还是渠道",
    body: "把招股书里的收入结构做成口播。对一级市场研究员，这是高信噪比素材。",
    author: "硬核科技现场",
    url: "https://www.douyin.com",
    media_type: "video",
    hours_ago: 28,
    views: 640000,
  },
  {
    source_id: "src_xhs_lab",
    platform: "xhs",
    external_id: "xhs-001",
    title: "我把 20 个行业公众号变成了可检索知识库",
    body: "WeWe RSS 定时拉全文，Telegram 用 message_id 去重，B 站只收新稿。真正难的是归一化字段，不是下载器。",
    author: "行业观察笔记",
    url: "https://www.xiaohongshu.com",
    media_type: "article",
    hours_ago: 5,
    views: 42000,
  },
  {
    source_id: "src_xhs_lab",
    platform: "xhs",
    external_id: "xhs-002",
    title: "品牌在小红书怎么讲硬科技而不翻车",
    body: "少讲愿景，多讲工艺照片、测试曲线和失败案例。笔记结构本身就是一种信息抽取模板。",
    author: "行业观察笔记",
    url: "https://www.xiaohongshu.com",
    media_type: "image",
    hours_ago: 22,
    views: 31000,
  },
  {
    source_id: "src_xhs_lab",
    platform: "xhs",
    external_id: "xhs-003",
    title: "一份半导体观察笔记：先进封装在把谁卷进去",
    body: "CoWoS 产能之外，国内 OSAT 的真实瓶颈是材料认证周期。先进封装的图片里的产线照片需要 OCR。",
    author: "行业观察笔记",
    url: "https://www.xiaohongshu.com",
    media_type: "image",
    hours_ago: 36,
    views: 27000,
  },
  {
    source_id: "src_xigua_auto",
    platform: "xigua",
    external_id: "xg-001",
    title: "国产大模型的行业落地样本：质检与客服",
    body: "两个已经签了合同的场景。演示之外，要看延迟、幻觉率和是否允许私有化。大模型进厂比进演示厅难。",
    author: "智驾车间",
    url: "https://www.ixigua.com",
    media_type: "video",
    hours_ago: 11,
    views: 180000,
  },
  {
    source_id: "src_xigua_auto",
    platform: "xigua",
    external_id: "xg-002",
    title: "短视频平台的信息密度实验",
    body: "同样一条工业资讯，在公众号、B 站和西瓜上的信息密度差了三倍。采集层必须保留平台字段。",
    author: "智驾车间",
    url: "https://www.ixigua.com",
    media_type: "video",
    hours_ago: 41,
    views: 92000,
  },
  {
    source_id: "src_tg_telegram",
    platform: "telegram",
    external_id: "telegram/seed-1",
    title: "公开频道是采集层，不是聊天层",
    body: "对 100–1000 个频道做 5/10/30 分钟扫描时，用 last_message_id 比 NewMessage 长连接更可运维。网页预览用于无会话冷启动。",
    author: "Telegram News",
    url: "https://t.me/telegram",
    media_type: "text",
    hours_ago: 3,
    views: 1600000,
  },
];

async function insertSource(s: SeedSource): Promise<void> {
  const sql = await getSql();
  await sql.query(
    `insert into sources (
       id, platform, name, handle, url, feed_url, interval_minutes, enabled,
       adapter, notes, status, last_scanned_at
     ) values ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,'idle',$10)
     on conflict (id) do nothing`,
    [
      s.id,
      s.platform,
      s.name,
      s.handle,
      s.url,
      s.feed_url,
      s.interval_minutes,
      s.adapter,
      s.notes,
      s.live ? null : new Date().toISOString(),
    ],
  );
}

export async function ensureRadarSource(): Promise<void> {
  const radar = SOURCES.find((s) => s.id === RADAR_SOURCE_ID);
  if (radar) await insertSource(radar);
}

async function tagSeedItems(): Promise<void> {
  const sql = await getSql();
  const keywords = await sql.query<{ phrase: string }>("select phrase from keywords");
  if (!keywords.length) return;
  const items = await sql.query<{ id: string; title: string; body: string; author: string }>(
    "select id, title, body, author from items",
  );
  for (const it of items) {
    const matched = keywords
      .filter((k) => itemMatchesPhrase(it.title, it.body, it.author, k.phrase))
      .map((k) => k.phrase);
    if (!matched.length) continue;
    await sql.query("update items set matched_keywords = $2::jsonb where id = $1", [
      it.id,
      JSON.stringify(matched),
    ]);
  }
  for (const k of keywords) {
    const [row] = await sql.query<{ n: number }>(
      `select count(*)::int as n from items
       where exists (select 1 from jsonb_array_elements_text(matched_keywords) t where t = $1)`,
      [k.phrase],
    );
    await sql.query("update keywords set hits = $2 where phrase = $1", [k.phrase, row?.n ?? 0]);
  }
}

export async function ensureKeywordsSeeded(): Promise<void> {
  const sql = await getSql();
  await ensureRadarSource();
  const [countRow] = await sql.query<{ n: number }>("select count(*)::int as n from keywords");
  if ((countRow?.n ?? 0) > 0) {
    return;
  }
  for (const k of KEYWORDS) {
    await sql.query(
      `insert into keywords (id, phrase, platforms, interval_minutes, enabled, notes, status)
       values ($1,$2,$3::jsonb,$4,true,$5,'idle')
       on conflict (id) do nothing`,
      [k.id, k.phrase, JSON.stringify(k.platforms), k.interval_minutes, k.notes],
    );
  }
  await tagSeedItems();
}

export async function ensureSeeded(): Promise<{ seeded: boolean; created: boolean }> {
  const sql = await getSql();
  const [meta] = await sql.query<{ value: string }>("select value from app_meta where key = 'seeded'");
  if (meta?.value === "1") {
    await ensureKeywordsSeeded();
    return { seeded: true, created: false };
  }

  const [countRow] = await sql.query<{ n: number }>("select count(*)::int as n from sources");
  if ((countRow?.n ?? 0) > 0) {
    await sql.query(
      "insert into app_meta (key, value) values ('seeded', '1') on conflict (key) do update set value = '1', updated_at = now()",
    );
    await ensureKeywordsSeeded();
    return { seeded: true, created: false };
  }

  for (const s of SOURCES) {
    await insertSource(s);
  }

  for (const it of ITEMS) {
    const published = new Date(Date.now() - it.hours_ago * 3600_000).toISOString();
    const id = `itm_${it.external_id}`;
    await sql.query(
      `insert into items (
         id, source_id, platform, external_id, title, body, author, url,
         media_type, media_urls, thumbnail_url, views, published_at, pipeline_status
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,'',$10,$11,'ingested')
       on conflict (source_id, external_id) do nothing`,
      [
        id,
        it.source_id,
        it.platform,
        it.external_id,
        it.title,
        it.body,
        it.author,
        it.url,
        it.media_type,
        it.views ?? null,
        published,
      ],
    );
  }

  await sql.query(
    "insert into app_meta (key, value) values ('seeded', '1') on conflict (key) do update set value = '1', updated_at = now()",
  );
  await ensureKeywordsSeeded();
  return { seeded: true, created: true };
}

export const LIVE_SOURCE_IDS = SOURCES.filter((s) => s.live && s.id !== RADAR_SOURCE_ID).map((s) => s.id);
