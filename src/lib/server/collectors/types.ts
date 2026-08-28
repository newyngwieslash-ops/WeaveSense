import type { MediaType, PlatformId } from "@/lib/platforms";

export type SourceRecord = {
  id: string;
  platform: PlatformId;
  name: string;
  handle: string;
  url: string;
  feed_url: string;
  adapter: string;
  last_external_id?: string;
};

export type NormalizedItem = {
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
  extra: Record<string, unknown>;
};

export type CollectorAdapter = {
  id: string;
  fetch(source: SourceRecord): Promise<NormalizedItem[]>;
};
