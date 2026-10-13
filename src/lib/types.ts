import type { AdapterId, MediaType, PlatformId } from "./platforms.ts";

export type SourceRow = {
  id: string;
  platform: PlatformId;
  name: string;
  handle: string;
  url: string;
  feed_url: string;
  interval_minutes: number;
  enabled: boolean;
  last_external_id: string;
  last_published_at: string | null;
  last_scanned_at: string | null;
  last_error: string;
  status: "idle" | "running" | "ok" | "error";
  adapter: AdapterId;
  notes: string;
  created_at: string;
  item_count?: number;
};

export type KeywordRow = {
  id: string;
  phrase: string;
  platforms: PlatformId[];
  interval_minutes: number;
  enabled: boolean;
  last_scanned_at: string | null;
  last_error: string;
  status: "idle" | "running" | "ok" | "error";
  hits: number;
  notes: string;
  created_at: string;
};

export type JsonScalar = string | number | boolean | null;

export type ArticleAvailability = { available: boolean; reason?: string };

export type ItemRow = {
  material_version?: number;
  id: string;
  source_id: string;
  platform: PlatformId;
  external_id: string;
  title: string;
  body: string;
  author: string;
  url: string;
  media_type: MediaType;
  media_urls: string[];
  thumbnail_url: string;
  views: number | null;
  likes: number | null;
  published_at: string | null;
  collected_at: string;
  pipeline_status: "ingested" | "extracted" | "analyzed" | "failed";
  extra: Record<string, JsonScalar>;
  matched_keywords: string[];
  source_name?: string;
};

export type JobRow = {
  id: string;
  source_id: string;
  platform: PlatformId;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "error" | "skipped";
  items_found: number;
  items_new: number;
  error: string;
  kind: string;
  provider: "" | "primary" | "dajiala" | "mixed";
  attempts: string[];
  paid_call: boolean;
  coverage: { complete?: boolean; window_only?: boolean; note?: string };
  keyword_id?: string;
  source_name?: string;
};

export type WechatHealthRow = {
  source_id: string;
  last_primary_ok_at: string | null;
  consecutive_primary_failures: number;
  recent_error_type: "" | "primary_feed_failed" | "technical_error" | "mapping_error";
  last_paid_check_at: string | null;
  last_paid_result: "" | "ok" | "technical_error" | "mapping_error";
  alert_state: "normal" | "degraded" | "paid_fallback" | "alert";
  next_retry_at: string | null;
};

export type WechatHealthUsage = {
  today: string;
  day: string;
  calls: number;
  amount: number;
  days: Array<{ day: string; calls: number; amount: number }>;
};

export type WechatHealthLimits = {
  daily_calls: number;
  daily_rmb: number;
  paid_configured: boolean;
};

export type WechatHealthOverview = {
  available: boolean;
  error: string;
  as_of: string | null;
  sources: WechatHealthRow[];
  usage: WechatHealthUsage | null;
  limits: WechatHealthLimits | null;
};

export type AnalysisRow = {
  id: string;
  item_id: string;
  summary: string;
  topics: string[];
  entities: string[];
  insights: string;
  tags: string[];
  model: string;
  created_at: string;
  run_id?: string | null;
  coverage?: "full" | "partial" | "unknown";
  warnings?: string[];
};

export type MediaObjectRow = {
  id: string;
  source_url: string;
  object_key: string;
  public_url: string;
  content_type: string;
  bytes: number | null;
  kind: string;
  status: string;
  error: string;
};

export type ExtractJobView = {
  id: string;
  kind: string;
  status: string;
  result_text: string;
  model: string;
  error: string;
  created_at: string;
};

export type KnowledgeNote = {
  citations?: { evidence_id: string; item_id: string | null; title: string; url: string; quote: string }[];
  id: string;
  title: string;
  content: string;
  kind: "briefing" | "answer" | "note";
  item_ids: string[];
  created_at: string;
  run_id?: string | null;
  coverage?: "full" | "partial" | "unknown";
  warnings?: string[];
  insufficient_evidence?: boolean;
};

export type PlatformStat = {
  platform: PlatformId;
  sources: number;
  enabled: number;
  items: number;
  last_scanned_at: string | null;
  status: string;
};

export type Overview = {
  seeded: boolean;
  source_count: number;
  enabled_count: number;
  item_count: number;
  job_count: number;
  analysis_count: number;
  note_count: number;
  new_24h: number;
  platforms: PlatformStat[];
  recent_items: ItemRow[];
  recent_jobs: JobRow[];
  due_count: number;
  keyword_count: number;
  keyword_enabled: number;
  keyword_due: number;
  keyword_hits: number;
  recent_keywords: KeywordRow[];
};

export type TickResult = {
  ran: number;
  items_new: number;
  errors: number;
  jobs: { source_id: string; name: string; items_new: number; error: string; kind?: string }[];
};

export type AskResult = {
  ok: boolean;
  error?: string;
  error_code?: string;
  run_id?: string;
  job_id?: string;
  pending?: boolean;
  answer?: string;
  note_id?: string;
  citations?: { id: string; title: string; platform: PlatformId }[];
  external_citations?: { title: string; url: string; quote: string }[];
  insufficient_evidence?: boolean;
};

export type ResearchStatus = {
  ok: true;
  job_id: string;
  status: string;
  phase: "queued" | "researching" | "reviewing" | "published" | "blocked" | "outcome_unknown" | "cancel_requested";
  terminal: boolean;
  can_cancel: boolean;
  review_mode: "off" | "shadow" | "enforce";
  error_code?: string;
  note_id?: string;
  candidate?: { content: string; citations: { evidence_id: string; quote: string }[] };
  review?: {
    checks: { id: string; status: "pass" | "fail" | "not_checked" }[];
    findings: { code: string; severity: "blocking" | "advisory"; claim: string; evidence_ids: string[]; reason: string; suggestion: string }[];
  };
};
