import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { parseKeywordList, parsePlatformList } from "@/lib/keyword";
import { defaultAdapter } from "./collectors";
import { prod } from "./config";
import { parseTelegramHandles, telethonHealth } from "./telethon";
import { analyzeItem, askKnowledge, generateBriefing } from "./analyze";
import { extractItem, extractPending } from "./extract";
import { ingestPending } from "./media";
import { getNodesStatus, runProductionTick } from "./nodes";
import { getOverview, listKeywords, listSources, mapAnalysis, mapExtractJob, mapItem, mapJob, mapMediaObject, mapNote } from "./queries";
import { ensureSeeded } from "./seed";
import { runKeywordJob, runSourceJob, tickDueSources } from "./scheduler";
import { isPlatform, type PlatformId } from "@/lib/platforms";
import { shortId } from "@/lib/utils";

export const bootstrapFn = createServerFn({ method: "POST" }).handler(async () => {
  const seed = await ensureSeeded();
  const overview = await getOverview();
  return { ...overview, created: seed.created };
});

export const overviewFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  return getOverview();
});

export const tickFn = createServerFn({ method: "POST" }).handler(async () => {
  const result = await tickDueSources(prod.tickLimit);
  const prodTick = await runProductionTick();
  return { ...result, stored: prodTick.stored, extracted: prodTick.extracted };
});

export const listSourcesFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  return listSources();
});

export const scanSourceFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    return runSourceJob(data.id, "manual");
  });

export const toggleSourceFn = createServerFn({ method: "POST" })
  .validator((input: { id: string; enabled: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    await sql.query("update sources set enabled = $2 where id = $1", [data.id, data.enabled]);
    return { ok: true };
  });

export const addSourceFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      platform: string;
      name: string;
      handle: string;
      url?: string;
      feed_url?: string;
      interval_minutes: number;
    }) => input,
  )
  .handler(async ({ data }) => {
    if (!isPlatform(data.platform)) throw new Error("未知平台");
    const name = data.name.trim().slice(0, 80);
    if (!name) throw new Error("请填写信源名称");
    const handle = data.handle.trim().slice(0, 400);
    const feed = (data.feed_url ?? "").trim();
    const url = (data.url ?? "").trim();
    if (!handle && !feed && !url) throw new Error("请填写账号、链接或 RSS 地址");
    const sql = await getSql();
    const id = shortId();
    await sql.query(
      `insert into sources (
         id, platform, name, handle, url, feed_url, interval_minutes, enabled, adapter, notes, status
       ) values ($1,$2,$3,$4,$5,$6,$7,true,$8,'', 'idle')`,
      [
        id,
        data.platform,
        name,
        handle,
        url,
        feed,
        data.interval_minutes || 30,
        defaultAdapter(data.platform as PlatformId),
      ],
    );
    return { id };
  });

export const addTelegramChannelsFn = createServerFn({ method: "POST" })
  .validator((input: { handles: string; interval_minutes: number }) => input)
  .handler(async ({ data }) => {
    const handles = parseTelegramHandles(data.handles);
    if (!handles.length) throw new Error("请粘贴频道用户名，每行一个");
    const interval = data.interval_minutes || 10;
    const sql = await getSql();
    const created: string[] = [];
    const skipped: string[] = [];
    for (const handle of handles) {
      const [exists] = await sql.query<{ id: string }>(
        "select id from sources where platform = 'telegram' and lower(handle) = lower($1) limit 1",
        [handle],
      );
      if (exists) {
        skipped.push(handle);
        continue;
      }
      const id = shortId();
      await sql.query(
        `insert into sources (
           id, platform, name, handle, url, feed_url, interval_minutes, enabled, adapter, notes, status
         ) values ($1,'telegram',$2,$3,$4,'',$5,true,'telegram_web','Telethon 增量',$6)`,
        [id, handle, handle, `https://t.me/s/${handle}`, interval, "idle"],
      );
      created.push(handle);
    }
    return { created: created.length, skipped: skipped.length, total: handles.length };
  });

export const listKeywordsFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  return listKeywords();
});

export const addKeywordsFn = createServerFn({ method: "POST" })
  .validator(
    (input: { phrases: string; interval_minutes: number; platforms?: string[] }) => input,
  )
  .handler(async ({ data }) => {
    const phrases = parseKeywordList(data.phrases);
    if (!phrases.length) throw new Error("请填写至少一个关键词（2–40 字）");
    const platforms = parsePlatformList(data.platforms ?? []);
    const interval = data.interval_minutes || 30;
    const sql = await getSql();
    const created: string[] = [];
    for (const phrase of phrases) {
      const [existing] = await sql.query<{ id: string }>(
        "select id from keywords where lower(phrase) = lower($1)",
        [phrase],
      );
      if (existing) {
        await sql.query(
          `update keywords set enabled = true, interval_minutes = $2, platforms = $3::jsonb, last_error = ''
           where id = $1`,
          [existing.id, interval, JSON.stringify(platforms)],
        );
        created.push(existing.id);
        continue;
      }
      const id = shortId();
      await sql.query(
        `insert into keywords (id, phrase, platforms, interval_minutes, enabled, notes, status)
         values ($1,$2,$3::jsonb,$4,true,'','idle')`,
        [id, phrase, JSON.stringify(platforms), interval],
      );
      created.push(id);
    }
    return { ids: created, count: created.length };
  });

export const scanKeywordFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    return runKeywordJob(data.id, "manual");
  });

export const toggleKeywordFn = createServerFn({ method: "POST" })
  .validator((input: { id: string; enabled: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    await sql.query("update keywords set enabled = $2 where id = $1", [data.id, data.enabled]);
    return { ok: true };
  });

export const updateKeywordFn = createServerFn({ method: "POST" })
  .validator((input: { id: string; interval_minutes?: number; platforms?: string[] }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    if (data.interval_minutes) {
      await sql.query("update keywords set interval_minutes = $2 where id = $1", [
        data.id,
        data.interval_minutes,
      ]);
    }
    if (data.platforms) {
      await sql.query("update keywords set platforms = $2::jsonb where id = $1", [
        data.id,
        JSON.stringify(parsePlatformList(data.platforms)),
      ]);
    }
    return { ok: true };
  });

export const removeKeywordFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    await sql.query("delete from keywords where id = $1", [data.id]);
    return { ok: true };
  });

export const listItemsFn = createServerFn({ method: "GET" })
  .validator(
    (input: { platform?: string; q?: string; media?: string; keyword?: string; limit?: number }) =>
      input,
  )
  .handler(async ({ data }) => {
    await ensureSeeded();
    const sql = await getSql();
    const limit = Math.min(Math.max(data.limit ?? 60, 1), 120);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (data.platform && isPlatform(data.platform)) {
      params.push(data.platform);
      clauses.push(`i.platform = $${params.length}`);
    }
    if (data.media) {
      params.push(data.media);
      clauses.push(`i.media_type = $${params.length}`);
    }
    if (data.q?.trim()) {
      params.push(`%${data.q.trim().replace(/[%_]/g, "")}%`);
      clauses.push(
        `(i.title ilike $${params.length} or i.body ilike $${params.length} or i.author ilike $${params.length})`,
      );
    }
    if (data.keyword?.trim()) {
      params.push(data.keyword.trim());
      clauses.push(
        `exists (select 1 from jsonb_array_elements_text(i.matched_keywords) t where t = $${params.length})`,
      );
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    params.push(limit);
    const rows = await sql.query<Record<string, unknown>>(
      `select i.*, s.name as source_name
       from items i join sources s on s.id = i.source_id
       ${where}
       order by coalesce(i.published_at, i.collected_at) desc
       limit $${params.length}`,
      params,
    );
    return rows.map(mapItem);
  });

export const getItemFn = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const [row] = await sql.query<Record<string, unknown>>(
      `select i.*, s.name as source_name
       from items i join sources s on s.id = i.source_id
       where i.id = $1`,
      [data.id],
    );
    if (!row) return { item: null, analysis: null, media: [], extracts: [] };
    const [analysis] = await sql.query<Record<string, unknown>>(
      "select * from analyses where item_id = $1 order by created_at desc limit 1",
      [data.id],
    );
    let media: ReturnType<typeof mapMediaObject>[] = [];
    let extracts: ReturnType<typeof mapExtractJob>[] = [];
    try {
      media = (
        await sql.query<Record<string, unknown>>(
          "select id, source_url, object_key, public_url, content_type, bytes, kind, status, error from media_objects where item_id = $1 order by created_at",
          [data.id],
        )
      ).map(mapMediaObject);
      extracts = (
        await sql.query<Record<string, unknown>>(
          "select id, kind, status, result_text, model, error, created_at from extract_jobs where item_id = $1 order by created_at desc limit 8",
          [data.id],
        )
      ).map(mapExtractJob);
    } catch {
      media = [];
      extracts = [];
    }
    return {
      item: mapItem(row),
      analysis: analysis ? mapAnalysis(analysis) : null,
      media,
      extracts,
    };
  });

export const listJobsFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select j.*, coalesce(nullif(k.phrase, ''), s.name) as source_name
     from jobs j
     left join sources s on s.id = j.source_id
     left join keywords k on k.id = j.keyword_id
     order by j.started_at desc
     limit 80`,
  );
  return rows.map(mapJob);
});

export const analyzeItemFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => analyzeItem(data.id));

export const briefingFn = createServerFn({ method: "POST" }).handler(async () => generateBriefing());

export const askFn = createServerFn({ method: "POST" })
  .validator((input: { question: string }) => input)
  .handler(async ({ data }) => askKnowledge(data.question));

export const listKnowledgeFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  const sql = await getSql();
  const notes = await sql.query<Record<string, unknown>>(
    "select * from knowledge_notes order by created_at desc limit 30",
  );
  const analyses = await sql.query<Record<string, unknown>>(
    `select a.*, i.title as item_title, i.platform as item_platform
     from analyses a join items i on i.id = a.item_id
     order by a.created_at desc
     limit 20`,
  );
  return {
    notes: notes.map(mapNote),
    analyses: analyses.map((r) => ({
      ...mapAnalysis(r),
      item_title: String(r.item_title ?? ""),
      item_platform: String(r.item_platform ?? ""),
    })),
  };
});

export const nodesStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  const status = await getNodesStatus();
  const tg = await telethonHealth();
  return { ...status, telethon_me: tg.me ?? "" };
});

export const extractItemFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => extractItem(data.id));

export const ingestMediaFn = createServerFn({ method: "POST" }).handler(async () => ingestPending(8));

export const extractPendingFn = createServerFn({ method: "POST" }).handler(async () => extractPending(3));

