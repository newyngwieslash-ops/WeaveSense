import { createServerFn } from "@tanstack/react-start";
import type { AskResult } from "../types";
import { getSql } from "@/lib/db";
import { parseKeywordList, parsePlatformList } from "@/lib/keyword";
import { defaultAdapter } from "./collectors";
import { prod, wechatGatewayConfigured, agentAsyncAvailable } from "./config";
import { parseTelegramHandles, telethonHealth } from "./telethon";
import { analyzeInput, askInput, briefingInput } from "../agent-contract.ts";
import { analyzeItemWith, askKnowledgeWith, generateBriefingWith } from "./analyze";
import { getResearchStatus, cancelResearchJob } from "./agent-research-status";
import { extractItem, extractPending } from "./extract";
import { ingestPending } from "./media";
import { getNodesStatus, runProductionTick } from "./nodes";
import { getOverview, listKeywords, listSources, mapAnalysis, mapExtractJob, mapItem, mapJob, mapMediaObject, mapNote } from "./queries";
import { ensureSeeded } from "./seed";
import { runKeywordJob, runSourceJob, tickDueSources } from "./scheduler";
import { isPlatform, type PlatformId } from "@/lib/platforms";
import { shortId } from "@/lib/utils";
import { importWechatSources, previewWechatImport } from "./wechat-import";
import { createProductionWechatGatewayClient } from "./wechat-gateway-client";
import { articleAdoptInput, articlePreviewInput, articleRestoreInput, articleErrorCopy } from "../article-contract";
import { adoptArticle, articleAvailability, previewArticle, restoreArticle } from "./article-enrichment";
import { readSubtitle, subtitleAvailability } from "./subtitles";
import { subtitleInput, subtitleErrorCopy } from "../subtitle-contract";
import { materialFingerprint } from "./agent-context";
import { mapAgentItem } from "./agent-retrieval";

const MAX_WECHAT_IMPORT_BYTES = 1024 * 1024;

function validateWechatCsvInput(input: unknown): { csv: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length !== 1 || !("csv" in input) || typeof input.csv !== "string") {
    throw new Error("wechat_import_invalid_input");
  }
  if (Buffer.byteLength(input.csv, "utf8") > MAX_WECHAT_IMPORT_BYTES) {
    throw new Error("CSV 文件不能超过 1 MiB");
  }
  return { csv: input.csv };
}

function validateWechatImportInput(input: unknown): { csv: string; confirmed_lines: number[] } {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !("csv" in input) || !("confirmed_lines" in input) ||
    typeof input.csv !== "string" || !Array.isArray(input.confirmed_lines) ||
    input.confirmed_lines.length > 1_000 || input.confirmed_lines.some((line) =>
      !Number.isSafeInteger(line) || Number(line) < 2) ||
    new Set(input.confirmed_lines).size !== input.confirmed_lines.length) {
    throw new Error("wechat_import_invalid_input");
  }
  if (Buffer.byteLength(input.csv, "utf8") > MAX_WECHAT_IMPORT_BYTES) {
    throw new Error("CSV 文件不能超过 1 MiB");
  }
  return { csv: input.csv, confirmed_lines: input.confirmed_lines as number[] };
}

async function getWechatImportSql() {
  try {
    return await getSql();
  } catch {
    throw new Error("database_check_failed");
  }
}

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

export const listWechatHealthFn = createServerFn({ method: "GET" }).handler(async () => {
  if (!wechatGatewayConfigured()) {
    return { available: false, error: "wechat_gateway_unconfigured",
      as_of: null, sources: [], usage: null, limits: null };
  }
  try {
    const health = await (await createProductionWechatGatewayClient()).listHealth();
    return { available: true, error: "", ...health };
  } catch (error) {
    const code = error instanceof Error && [
      "wechat_gateway_timeout", "wechat_gateway_unauthorized", "wechat_gateway_http_error",
      "wechat_gateway_invalid_response", "wechat_gateway_response_too_large", "wechat_gateway_unavailable",
    ].includes(error.message) ? error.message : "wechat_gateway_unavailable";
    return { available: false, error: code, as_of: null, sources: [], usage: null, limits: null };
  }
});

export const previewWechatImportFn = createServerFn({ method: "POST" })
  .validator(validateWechatCsvInput)
  .handler(async ({ data }) => {
    const sql = await getWechatImportSql();
    let rows: Array<{ handle: string }>;
    try {
      rows = await sql.query<{ handle: string }>(
        "select handle from sources where platform = 'wechat'",
      );
    } catch {
      throw new Error("database_check_failed");
    }
    return previewWechatImport(data.csv, new Set(rows.map((row) => row.handle)));
  });

export const importWechatSourcesFn = createServerFn({ method: "POST" })
  .validator(validateWechatImportInput)
  .handler(async ({ data }) => {
    const sql = await getWechatImportSql();
    let existingRows: Array<{ handle: string }>;
    try {
      existingRows = await sql.query<{ handle: string }>(
        "select handle from sources where platform = 'wechat'",
      );
    } catch {
      throw new Error("database_check_failed");
    }
    const client = await createProductionWechatGatewayClient();
    return importWechatSources(data, {
      existingWechatIds: new Set(existingRows.map((row) => row.handle)),
      findExisting: async (wechatId) => Boolean((await sql.query<{ id: string }>(
        "select id from sources where platform = 'wechat' and lower(handle) = lower($1) limit 1",
        [wechatId],
      ))[0]),
      putSource: (source) => client.putSource(source),
      insertSource: (source) => sql.query(
        `insert into sources (
           id, platform, name, handle, url, feed_url, interval_minutes, enabled, adapter, notes, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [source.id, source.platform, source.name, source.handle, source.url, source.feed_url,
          source.interval_minutes, source.enabled, source.adapter, source.notes, source.status],
      ),
    });
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
    const feed = (data.feed_url ?? "").trim();
    const url = (data.url ?? "").trim();
    let handle = data.handle.trim().slice(0, 400);
    let storedUrl = url;
    if (data.platform === "telegram") {
      const parsed = parseTelegramHandles([handle, url, feed].filter(Boolean).join("\n"))[0] ?? "";
      if (!parsed) throw new Error("请填写频道用户名，或 t.me/用户名 链接");
      handle = parsed;
      storedUrl = `https://t.me/s/${parsed}`;
    }
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
        storedUrl,
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
    if (!row) return { item: null, analysis: null, media: [], extracts: [], articleReader: { available: false, reason: "" }, subtitleReader: { available: false, reason: "" }, analysisStale: false };
    const [analysis] = await sql.query<Record<string, unknown>>(
      `select a.*, r.response_json, r.material_hash as run_material_hash
       from analyses a
       left join ai_runs r on r.id = a.run_id
       where a.item_id = $1
       order by a.created_at desc limit 1`,
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
      item: mapItem(row, { articleDetail: true }),
      analysis: analysis ? mapAnalysis(analysis) : null,
      analysisStale: Boolean(analysis && analysis.run_material_hash !== materialFingerprint(mapAgentItem(row))),
      articleReader: articleAvailability({ media_type: row.media_type, platform: row.platform, url: row.url, extra: row.extra }),
      subtitleReader: subtitleAvailability(row),
      media,
      extracts,
    };
  });

export const previewArticleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = articlePreviewInput.safeParse(input);
    if (!parsed.success) throw new Error(articleErrorCopy("article_invalid_input"));
    return parsed.data;
  })
  .handler(async ({ data }) => {
    try { await previewArticle(data.id); return { ok: true }; }
    catch (error) { return { ok: false, error: articleErrorCopy(error instanceof Error ? error.message : undefined) }; }
  });

export const readSubtitleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = subtitleInput.safeParse(input);
    if (!parsed.success) throw new Error(subtitleErrorCopy("subtitle_invalid_input"));
    return parsed.data;
  })
  .handler(async ({ data }) => {
    try { return { ok: true as const, ...await readSubtitle(data.id, data.language) }; }
    catch (error) { return { ok: false as const, error: subtitleErrorCopy(error instanceof Error ? error.message : undefined) }; }
  });

export const adoptArticleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = articleAdoptInput.safeParse(input);
    if (!parsed.success) throw new Error(articleErrorCopy("article_invalid_input"));
    return parsed.data;
  })
  .handler(async ({ data }) => {
    try { await adoptArticle(data.id, data.digest, data.material_version); return { ok: true }; }
    catch (error) { return { ok: false, error: articleErrorCopy(error instanceof Error ? error.message : undefined) }; }
  });

export const restoreArticleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = articleRestoreInput.safeParse(input);
    if (!parsed.success) throw new Error(articleErrorCopy("article_invalid_input"));
    return parsed.data;
  })
  .handler(async ({ data }) => {
    try { await restoreArticle(data.id, data.material_version); return { ok: true }; }
    catch (error) { return { ok: false, error: articleErrorCopy(error instanceof Error ? error.message : undefined) }; }
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
  .validator((input: unknown) => analyzeInput.parse(input ?? {}))
  .handler(async ({ data }) => analyzeItemWith({ sql: await getSql(), itemId: data.id, requestId: data.request_id }));

export const briefingFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => briefingInput.parse(input && typeof input === "object" ? input : {}))
  .handler(async ({ data }) => generateBriefingWith({
    sql: await getSql(), requestId: data.request_id, from: data.from, to: data.to,
  }));

export const askFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => askInput.parse(input ?? {}))
  .handler(async ({ data }): Promise<AskResult> => {
    if (data.async && !await trustedResearchAccess()) return { ok: false, error: "深入研究仅对已配置的可信本机访问开放", error_code: "trusted_access_required" };
    if (data.async && !agentAsyncAvailable()) return { ok: false, error: "深入研究当前不可用", error_code: "capability_unavailable" };
    return askKnowledgeWith({ sql: await getSql(), question: data.question, requestId: data.request_id, async: Boolean(data.async) });
  });

// Research drafts and cancellation share the existing trusted local operator boundary.
// This is deliberately not a substitute for multi-user resource authorization.
async function trustedResearchAccess(): Promise<boolean> {
  const [{ getRequest, getRequestIP }, { localModelAccess }] = await Promise.all([
    import("@tanstack/react-start/server"), import("./model-config"),
  ]);
  return localModelAccess(getRequest(), getRequestIP({ xForwardedFor: false }));
}

function researchJobInput(input: unknown): { id: string } {
  const id = input && typeof input === "object" && "id" in input ? (input as { id?: unknown }).id : null;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("invalid_job");
  return { id };
}

export const getAskJobFn = createServerFn({ method: "POST" })
  .validator(researchJobInput)
  .handler(async ({ data }) => {
    if (!await trustedResearchAccess()) return { ok: false as const, error_code: "trusted_access_required" };
    return await getResearchStatus(await getSql(), data.id) ?? { ok: false as const, error_code: "not_found" };
  });

export const cancelAskJobFn = createServerFn({ method: "POST" })
  .validator(researchJobInput)
  .handler(async ({ data }) => {
    if (!await trustedResearchAccess()) return { ok: false as const, error_code: "trusted_access_required" };
    return cancelResearchJob(await getSql(), data.id, true);
  });

export const listKnowledgeFn = createServerFn({ method: "GET" }).handler(async () => {
  await ensureSeeded();
  const sql = await getSql();
  const notes = await sql.query<Record<string, unknown>>(
    `select n.*, r.response_json
     from knowledge_notes n
     left join ai_runs r on r.id = n.run_id
     order by n.created_at desc limit 30`,
  );
  const analyses = await sql.query<Record<string, unknown>>(
    `select a.*, i.title as item_title, i.platform as item_platform, r.response_json
     from analyses a
     join items i on i.id = a.item_id
     left join ai_runs r on r.id = a.run_id
     order by a.created_at desc
     limit 20`,
  );
  return {
    capabilities: { engine: prod.aiEngine, async_research: agentAsyncAvailable() && await trustedResearchAccess() },
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

