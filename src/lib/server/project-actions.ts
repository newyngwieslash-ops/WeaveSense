/**
 * Shared keyword/source domain functions (plan Task 5 / §3.1).
 *
 * Extracted from fns.ts so the assistant can run the same writes as the
 * pages — with the same SQL semantics — under explicit actor/operation
 * contexts. Page callers keep their legacy behavior (addKeywords re-enables
 * and overwrites an existing keyword; page-created sources start enabled).
 * Assistant callers pass onExisting:"returnExisting" and enabled:false so a
 * keyword.create never silently rewrites an existing rule (§3.1 A28).
 *
 * Every function receives a Queryable (a transaction handle in production
 * paths) and never opens its own connection: the caller's transaction owns
 * receipt atomicity.
 */
import { parseTelegramHandle } from "../telegram-handle.ts";
import { isPlatform, type PlatformId } from "../platforms.ts";

/**
 * ponytail: duplicated from collectors/index.ts defaultAdapter because that
 * module's extensionless imports only resolve under Vite, not under
 * `node --experimental-strip-types`. Upgrade path: fix the extensionless
 * imports there and import the single source again.
 */
function defaultAdapter(platform: PlatformId): string {
  if (platform === "wechat") return "wechat_gateway";
  if (platform === "telegram") return "telegram_web";
  if (platform === "bilibili") return "bilibili";
  if (platform === "youtube") return "youtube";
  if (platform === "douyin" || platform === "xhs" || platform === "xigua") return "rsshub";
  return "rss";
}

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

/** Trusted caller identity. Page handlers pass kind:"page"; the assistant
 *  executor passes kind:"assistant" with its persisted operation. Model
 *  output can never construct these — see §6.2. */
export type ActorContext =
  | { kind: "page" }
  | { kind: "assistant"; operation: { actionId: string } }
  | { kind: "scheduler" };

export type OperationContext = { actionId: string } | null;

export type KeywordWriteOptions = {
  /** page (default): legacy add semantics. assistant: report existing rows. */
  onExisting?: "update" | "returnExisting";
};

export type KeywordMutation =
  | { kind: "created"; keywordId: string; phrase: string }
  | { kind: "updated"; keywordId: string; phrase: string; before?: { interval: number; platforms: string[]; enabled: boolean }; after?: { interval: number; platforms: string[] } }
  | { kind: "existing"; keywordId: string; phrase: string; currentInterval: number; currentPlatforms: string[]; currentEnabled: boolean }
  | { kind: "not_found"; keywordId?: string }
  | { kind: "unchanged"; keywordId: string };

export type SourceMutation =
  | { kind: "created"; sourceId: string; platform: string; enabled: boolean }
  | { kind: "updated"; sourceId: string }
  | { kind: "unchanged"; sourceId: string }
  | { kind: "not_found"; sourceId?: string };

export class DomainError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const PLATFORM_IDS_SET = new Set<string>(["telegram", "wechat", "bilibili", "douyin", "xhs", "youtube", "xigua", "rss"]);

/** Assistant writes need a non-empty, known platform list (§3.1). */
function assertAssistantPlatforms(platforms: string[]): asserts platforms is PlatformId[] {
  if (!Array.isArray(platforms) || platforms.length === 0) throw new DomainError("invalid_platform");
  for (const p of platforms) {
    if (typeof p !== "string" || !PLATFORM_IDS_SET.has(p)) throw new DomainError("invalid_platform");
  }
}

function normalizePlatforms(platforms: string[] | undefined): string[] {
  if (!platforms) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of platforms) {
    if (typeof p !== "string" || !PLATFORM_IDS_SET.has(p)) throw new DomainError("invalid_platform");
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * One keyword create. `keyword` is a single normalized phrase: assistant
 * actions accept one word per action (no comma splitting — that is the
 * page's parseKeywordList batch path, bounded to 4 actions per turn).
 */
export async function addKeywordDomain(
  sql: Queryable,
  actor: ActorContext,
  operation: OperationContext,
  input: { keyword: string; platforms: string[]; interval: number; enabled: boolean },
  options: KeywordWriteOptions = {},
): Promise<KeywordMutation> {
  const phrase = input.keyword.trim().replace(/\s+/g, " ");
  if (phrase.length < 2 || phrase.length > 40) throw new DomainError("invalid_keyword");
  if (/[，,、;；\n\r]/.test(phrase)) throw new DomainError("multi_phrase");
  const platforms = normalizePlatforms(input.platforms);
  if (actor.kind === "assistant") assertAssistantPlatforms(platforms);
  const interval = input.interval;
  if (![5, 10, 30, 60, 180, 1440].includes(interval)) throw new DomainError("invalid_interval");

  const onExisting = options.onExisting ?? "update";
  // Serialize duplicate-name checks inside the caller's transaction (§6.1:
  // the concurrent same-name race is arbitrated by the keywords_phrase_lower
  // unique index; we surface it as existing rather than crashing).
  const [existing] = await sql.query<{ id: string; interval_minutes: number; platforms: string[]; enabled: boolean }>(
    "select id, interval_minutes, platforms, enabled from keywords where lower(phrase) = lower($1) limit 1",
    [phrase],
  );
  if (existing) {
    if (onExisting === "returnExisting") {
      const platforms = Array.isArray(existing.platforms) ? existing.platforms : [];
      return {
        kind: "existing", keywordId: String(existing.id), phrase,
        currentInterval: Number(existing.interval_minutes),
        currentPlatforms: platforms, currentEnabled: Boolean(existing.enabled),
      };
    }
    await sql.query(
      `update keywords set enabled = true, interval_minutes = $2, platforms = $3::jsonb, last_error = ''
       where id = $1`,
      [existing.id, interval, JSON.stringify(platforms)],
    );
    return { kind: "updated", keywordId: String(existing.id), phrase,
      before: { interval: Number(existing.interval_minutes), platforms: Array.isArray(existing.platforms) ? existing.platforms : [], enabled: Boolean(existing.enabled) } };
  }
  const id = cryptoRandomId();
  await sql.query(
    `insert into keywords (id, phrase, platforms, interval_minutes, enabled, notes, status)
     values ($1,$2,$3::jsonb,$4,$5,'','idle')`,
    [id, phrase, JSON.stringify(platforms), interval, input.enabled],
  );
  return { kind: "created", keywordId: id, phrase };
}

export async function updateKeywordDomain(
  sql: Queryable,
  actor: ActorContext,
  operation: OperationContext,
  keywordId: string,
  patch: { interval?: number; platforms?: string[] },
): Promise<KeywordMutation> {
  const [existing] = await sql.query<Record<string, unknown>>(
    "select id, interval_minutes, platforms, enabled from keywords where id = $1", [keywordId],
  );
  if (!existing) return { kind: "not_found" };
  const before = {
    interval: Number(existing.interval_minutes),
    platforms: Array.isArray(existing.platforms) ? existing.platforms as string[] : [],
    enabled: Boolean(existing.enabled),
  };
  if (existing.enabled === undefined) before.enabled = true;
  const nextInterval = patch.interval ?? before.interval;
  if (![5, 10, 30, 60, 180, 1440].includes(nextInterval)) throw new DomainError("invalid_interval");
  let nextPlatforms = before.platforms;
  if (patch.platforms !== undefined) {
    nextPlatforms = normalizePlatforms(patch.platforms);
    if (actor.kind === "assistant" && nextPlatforms.length === 0) throw new DomainError("invalid_platform");
  }
  await sql.query(
    "update keywords set interval_minutes = $2, platforms = $3::jsonb where id = $1",
    [keywordId, nextInterval, JSON.stringify(nextPlatforms)],
  );
  return { kind: "updated", keywordId, phrase: "", before, after: { interval: nextInterval, platforms: nextPlatforms } };
}

export async function setKeywordEnabledDomain(
  sql: Queryable,
  actor: ActorContext,
  operation: OperationContext,
  keywordId: string,
  enabled: boolean,
): Promise<KeywordMutation> {
  const [existing] = await sql.query<{ id: string; enabled: boolean }>(
    "select id, enabled from keywords where id = $1", [keywordId],
  );
  if (!existing) return { kind: "not_found" };
  if (Boolean(existing.enabled) === enabled) return { kind: "unchanged", keywordId };
  await sql.query("update keywords set enabled = $2 where id = $1", [keywordId, enabled]);
  return { kind: "updated", keywordId, phrase: "" };
}

export type CreateSourceInput = {
  platform: string;
  name: string;
  handle?: string;
  url?: string;
  feedUrl?: string;
  interval: number;
  enabled: boolean;
};

export async function createSourceDomain(
  sql: Queryable,
  actor: ActorContext,
  operation: OperationContext,
  input: CreateSourceInput,
): Promise<{ kind: "created"; sourceId: string; platform: string; enabled: boolean }> {
  if (!isPlatform(input.platform)) throw new DomainError("invalid_platform");
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new DomainError("invalid_name");
  const feed = (input.feedUrl ?? "").trim();
  const url = (input.url ?? "").trim();
  let handle = (input.handle ?? "").trim().slice(0, 400);
  let storedUrl = url;
  if (input.platform === "telegram") {
    const parsed = parseTelegramHandle([handle, url, feed].filter(Boolean).join("\n"));
    if (!parsed) throw new DomainError("invalid_telegram_handle");
    handle = parsed;
    storedUrl = `https://t.me/s/${parsed}`;
  }
  if (!handle && !feed && !url) throw new DomainError("missing_source_target");
  const id = cryptoRandomId();
  await sql.query(
    `insert into sources (
       id, platform, name, handle, url, feed_url, interval_minutes, enabled, adapter, notes, status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'','idle')`,
    [id, input.platform, name, handle, storedUrl, feed, input.interval || 30, input.enabled, defaultAdapter(input.platform)],
  );
  return { kind: "created", sourceId: id, platform: input.platform, enabled: input.enabled };
}

export async function setSourceEnabledDomain(
  sql: Queryable,
  actor: ActorContext,
  operation: OperationContext,
  sourceId: string,
  enabled: boolean,
): Promise<SourceMutation> {
  const [existing] = await sql.query<{ id: string; enabled: boolean }>(
    "select id, enabled from sources where id = $1", [sourceId],
  );
  if (!existing) return { kind: "not_found" };
  if (Boolean(existing.enabled) === enabled) return { kind: "unchanged", sourceId };
  await sql.query("update sources set enabled = $2 where id = $1", [sourceId, enabled]);
  return { kind: "updated", sourceId };
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
