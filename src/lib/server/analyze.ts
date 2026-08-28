import { getSql } from "@/lib/db";
import { shortId } from "@/lib/utils";
import { mapItem } from "./queries";
import type { AskResult } from "@/lib/types";

const MODEL = "grok-4.5";

async function chat(system: string, user: string, maxTokens: number): Promise<
  { ok: true; text: string } | { ok: false; error: string }
> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, error: "当前环境未启用 AI 分析" };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) return { ok: false, error: `xAI API ${res.status}` };
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) return { ok: false, error: "模型没有返回内容" };
  return { ok: true, text };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function strArr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean).slice(0, 12);
}

export async function analyzeItem(itemId: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  const sql = await getSql();
  const [raw] = await sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name from items i join sources s on s.id = i.source_id where i.id = $1`,
    [itemId],
  );
  if (!raw) return { ok: false, error: "内容不存在" };
  const item = mapItem(raw);

  const result = await chat(
    "你是织识（Loom）的行业媒体分析师。只根据给定素材抽取对行业知识库有用的信息。用中文。必须返回 JSON。",
    `请分析这条采集内容，返回 JSON：{"summary":"80字内摘要","topics":["主题"],"entities":["实体"],"insights":"对行业研究的一条洞察","tags":["标签"]}\n\n平台: ${item.platform}\n信源: ${item.source_name}\n作者: ${item.author}\n标题: ${item.title}\n正文: ${item.body.slice(0, 2800)}`,
    700,
  );
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.text);
  const summary = String(parsed?.summary ?? result.text).slice(0, 1200);
  const insights = String(parsed?.insights ?? "").slice(0, 1200);
  const id = shortId();
  await sql.query(
    `insert into analyses (id, item_id, summary, topics, entities, insights, tags, model)
     values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8)`,
    [
      id,
      itemId,
      summary,
      JSON.stringify(strArr(parsed?.topics)),
      JSON.stringify(strArr(parsed?.entities)),
      insights,
      JSON.stringify(strArr(parsed?.tags)),
      MODEL,
    ],
  );
  await sql.query("update items set pipeline_status = 'analyzed' where id = $1", [itemId]);
  return { ok: true, id };
}

export async function generateBriefing(): Promise<{ ok: boolean; error?: string; id?: string; title?: string }> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name
     from items i join sources s on s.id = i.source_id
     order by coalesce(i.published_at, i.collected_at) desc
     limit 12`,
  );
  if (!rows.length) return { ok: false, error: "还没有可分析的内容" };
  const digest = rows
    .map((r, i) => {
      const item = mapItem(r);
      return `${i + 1}. [${item.platform}/${item.source_name}] ${item.title}\n${item.body.slice(0, 280)}`;
    })
    .join("\n\n");
  const result = await chat(
    "你是织识的行业情报主编。根据采集到的媒体条目写一份简洁、具体、可执行的中文简报。不要空话，不要表情符号。结构：一、今日信号 二、跨平台交叉 三、值得跟进的问题。",
    `以下是最近采集的条目：\n\n${digest}`,
    1100,
  );
  if (!result.ok) return result;
  const id = shortId();
  const title = `行业简报 · ${new Date().toLocaleDateString("zh-CN")}`;
  await sql.query(
    `insert into knowledge_notes (id, title, content, kind, item_ids)
     values ($1,$2,$3,'briefing',$4::jsonb)`,
    [id, title, result.text, JSON.stringify(rows.map((r) => String(r.id)))],
  );
  return { ok: true, id, title };
}

export async function askKnowledge(question: string): Promise<AskResult> {
  const q = question.trim().slice(0, 400);
  if (q.length < 2) return { ok: false, error: "请输入问题" };
  const sql = await getSql();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  let rows = await sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name
     from items i join sources s on s.id = i.source_id
     where i.title ilike $1 or i.body ilike $1 or i.author ilike $1
     order by coalesce(i.published_at, i.collected_at) desc
     limit 8`,
    [like],
  );
  if (!rows.length) {
    rows = await sql.query<Record<string, unknown>>(
      `select i.*, s.name as source_name
       from items i join sources s on s.id = i.source_id
       order by coalesce(i.published_at, i.collected_at) desc
       limit 8`,
    );
  }
  const citations = rows.map((r) => {
    const item = mapItem(r);
    return { id: item.id, title: item.title, platform: item.platform };
  });
  const context = rows
    .map((r, i) => {
      const item = mapItem(r);
      return `#${i + 1} ${item.title}（${item.source_name} / ${item.platform}）\n${item.body.slice(0, 500)}`;
    })
    .join("\n\n");
  const result = await chat(
    "你是织识知识库助手。只根据提供的采集条目回答。用中文。引用条目标题。如果材料不足，明确说不足，不要编造。",
    `问题：${q}\n\n材料：\n${context}`,
    800,
  );
  if (!result.ok) return { ok: false, error: result.error, citations };
  const id = shortId();
  await sql.query(
    `insert into knowledge_notes (id, title, content, kind, item_ids)
     values ($1,$2,$3,'answer',$4::jsonb)`,
    [id, q.slice(0, 80), result.text, JSON.stringify(citations.map((c) => c.id))],
  );
  return { ok: true, answer: result.text, note_id: id, citations };
}
