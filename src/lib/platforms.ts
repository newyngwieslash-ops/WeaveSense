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
    blurb: "WeWe RSS / 任意 Atom 订阅，适合定时全文采集",
    icon: BookOpen,
    adapter: "wechat_gateway",
    license: "MIT",
    foundation: "WeWe RSS",
    handleLabel: "RSS 地址",
    handlePlaceholder: "https://…/rss",
    live: true,
  },
  bilibili: {
    id: "bilibili",
    name: "B站",
    nameEn: "Bilibili",
    blurb: "UP 主视频增量；生产可接 bilibili-cli / bilibee 字幕",
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
    blurb: "账号作品扫描；生产接 cmsjin/douyin + 浏览器回退",
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
    blurb: "笔记与媒体下载；生产接 xhs-downloader",
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
    blurb: "频道 RSS 增量；媒体下载走 yt-dlp 独立进程",
    icon: Youtube,
    adapter: "youtube",
    license: "Unlicense",
    foundation: "yt-dlp",
    handleLabel: "Channel ID",
    handlePlaceholder: "UCxxxxxxxx",
    live: false,
  },
  xigua: {
    id: "xigua",
    name: "西瓜视频",
    nameEn: "Xigua",
    blurb: "字节系短视频；无稳定 MIT 爬虫，走浏览器/RSSHub 封装",
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
