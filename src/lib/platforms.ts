import {
  BookOpen,
  Clapperboard,
  Rss,
  Send,
  Smartphone,
  Tv,
  Youtube,
  type LucideIcon,
} from "lucide-react";

export const PLATFORM_IDS = [
  "telegram",
  "wechat",
  "bilibili",
  "douyin",
  "xhs",
  "youtube",
  "xigua",
  "rss",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export type AdapterId = "rss" | "telegram_web" | "bilibili" | "youtube" | "rsshub" | "wechat_gateway";

export type IntervalMinutes = 5 | 10 | 30 | 60 | 180 | 1440;

// Static support is not evidence that a user's upstream has been verified.
export const PLATFORM_CAPABILITIES: Record<PlatformId, {
  history: "paged" | "window" | "none"; search: "native" | "index" | "none";
  media: "reference" | "download" | "none"; required: string;
}> = {
  telegram: { history: "paged", search: "none", media: "download", required: "公开频道用户名；历史回填需已授权 Telethon，网页仅当前窗口" },
  wechat: { history: "window", search: "none", media: "reference", required: "先以 CSV 配置网关主源；已有网关账号可按微信 ID 关联" },
  bilibili: { history: "paged", search: "native", media: "reference", required: "明确 UP mid / space.bilibili.com 主页，或已验证 Feed；接口仍可能限流" },
  youtube: { history: "window", search: "index", media: "reference", required: "UC 开头的 24 字符频道 ID，或有效 Feed" },
  rss: { history: "window", search: "index", media: "reference", required: "有效的公共 RSS / Atom URL" },
  douyin: { history: "window", search: "none", media: "reference", required: "必填已授权或可验证的 RSS / Atom Feed" },
  xhs: { history: "window", search: "none", media: "reference", required: "必填已授权或可验证的 RSS / Atom Feed" },
  xigua: { history: "window", search: "none", media: "reference", required: "必填已授权或可验证的 RSS / Atom Feed" },
};

export const INTERVALS: { value: IntervalMinutes; label: string }[] = [
  { value: 5, label: "每 5 分钟" },
  { value: 10, label: "每 10 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 60, label: "每小时" },
  { value: 180, label: "每 3 小时" },
  { value: 1440, label: "每天" },
];

export type PlatformDef = {
  id: PlatformId;
  name: string;
  nameEn: string;
  blurb: string;
  icon: LucideIcon;
  adapter: AdapterId;
  license: string;
  foundation: string;
  handleLabel: string;
  handlePlaceholder: string;
  live: boolean;
};

export const PLATFORMS: Record<PlatformId, PlatformDef> = {
  telegram: {
    id: "telegram",
    name: "Telegram",
    nameEn: "Telethon",
    blurb: "Telethon MTProto 增量（Docker 节点）；未连接时回退 t.me/s",
    icon: Send,
    adapter: "telegram_web",
    license: "MIT",
    foundation: "Telethon / t.me/s",
    handleLabel: "频道用户名",
    handlePlaceholder: "telegram",
    live: true,
  },
  wechat: {
    id: "wechat",
    name: "微信公众号",
    nameEn: "WeChat",
    blurb: "通过微信网关采集，保留主源 / 付费兜底与预算记录",
    icon: BookOpen,
    adapter: "wechat_gateway",
    license: "MIT",
    foundation: "WeWe RSS",
    handleLabel: "已有网关配置的微信 ID",
    handlePlaceholder: "gh_example",
    live: true,
  },
  bilibili: {
    id: "bilibili",
    name: "B站",
    nameEn: "Bilibili",
    blurb: "UP 主视频分页；可用性需以授权接口 / Feed 实际验证",
    icon: Tv,
    adapter: "bilibili",
    license: "MIT",
    foundation: "bilibili-cli",
    handleLabel: "UP mid",
    handlePlaceholder: "163637592",
    live: false,
  },
  douyin: {
    id: "douyin",
    name: "抖音",
    nameEn: "Douyin",
    blurb: "通过已配置 Feed 采集当前窗口；没有原生账号扫描",
    icon: Smartphone,
    adapter: "rsshub",
    license: "MIT",
    foundation: "cmsjin/douyin",
    handleLabel: "账号 / RSSHub",
    handlePlaceholder: "sec_uid 或 RSS URL",
    live: false,
  },
  xhs: {
    id: "xhs",
    name: "小红书",
    nameEn: "Xiaohongshu",
    blurb: "通过已配置 Feed 采集当前窗口；没有原生账号扫描",
    icon: BookOpen,
    adapter: "rsshub",
    license: "MIT",
    foundation: "xhs-downloader",
    handleLabel: "用户 / RSS",
    handlePlaceholder: "用户 ID 或 RSS URL",
    live: false,
  },
  youtube: {
    id: "youtube",
    name: "YouTube",
    nameEn: "YouTube",
    blurb: "频道 RSS 当前窗口；关键词通过新闻索引检索",
    icon: Youtube,
    adapter: "youtube",
    license: "Unlicense",
    foundation: "yt-dlp",
    handleLabel: "Channel ID",
    handlePlaceholder: "UC + 22 位字母、数字、_ 或 -",
    live: false,
  },
  xigua: {
    id: "xigua",
    name: "西瓜视频",
    nameEn: "Xigua",
    blurb: "通过已配置 Feed 采集当前窗口；没有原生账号扫描",
    icon: Clapperboard,
    adapter: "rsshub",
    license: "自研",
    foundation: "collector-xigua",
    handleLabel: "用户 / RSS",
    handlePlaceholder: "用户 ID 或 RSS URL",
    live: false,
  },
  rss: {
    id: "rss",
    name: "RSS / Atom",
    nameEn: "RSSHub",
    blurb: "矩阵的总线层：新闻、博客、公众号、频道均可接入",
    icon: Rss,
    adapter: "rss",
    license: "MIT",
    foundation: "RSSHub",
    handleLabel: "Feed URL",
    handlePlaceholder: "https://example.com/feed",
    live: true,
  },
};

export const PLATFORM_LIST = PLATFORM_IDS.map((id) => PLATFORMS[id]);

export const MEDIA_TYPES = [
  "article",
  "text",
  "image",
  "video",
  "audio",
  "file",
  "link",
] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_TYPE_LABEL: Record<MediaType, string> = {
  article: "文章",
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
  link: "链接",
};

export function isPlatform(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

export const PIPELINE_STAGES = [
  { id: "collect", label: "采集", hint: "RSS / API / 浏览器" },
  { id: "normalize", label: "归一化", hint: "message_id 去重" },
  { id: "store", label: "PostgreSQL", hint: "元数据 + 游标" },
  { id: "object", label: "对象存储", hint: "MinIO" },
  { id: "extract", label: "ASR / OCR", hint: "Grok STT / 视觉" },
  { id: "llm", label: "LLM", hint: "Grok 分析" },
  { id: "knowledge", label: "知识库", hint: "检索 / 简报" },
] as const;
