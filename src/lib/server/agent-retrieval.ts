import { splitQueryTerms, rangePredicate, rankRetrievedItems } from "./agent-context.ts";
import { expandTerms } from "./term-glossary.ts";
import type { ItemRow } from "../types.ts";
import type { AgentSql } from "./agent-transaction.ts";

export function mapAgentItem(row: Record<string, any>): ItemRow {
  return { ...row, id: String(row.id), title: row.title ?? "", body: row.body ?? "", author: row.author ?? "", url: row.url ?? "",
    platform: row.platform, source_name: row.source_name ?? "", extra: row.extra ?? {}, media_urls: row.media_urls ?? [],
    published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    collected_at: row.collected_at ? new Date(row.collected_at).toISOString() : new Date().toISOString() } as ItemRow;
}

/** Shared SQL candidate path for initial research, search_items and offline evaluation. */
export async function retrieveAgentItems(sql: AgentSql, query: string, range: { from: string; to: string } | null = null, limit = 8) {
  const terms = splitQueryTerms(query);
  const params: unknown[] = [];
  const matches: string[] = [], scores: string[] = [];
  // T15: search each term AND its declared equivalent forms (电动垂直起降 → eVTOL).
  // Without this the SQL candidate stage never returns a document that only uses
  // the acronym, so the scoring fix alone could not have recovered it.
  const searched = [...new Set((terms.length ? terms : [query]).flatMap((term) => [term, ...expandTerms(term)]))];
  for (const term of searched) {
    params.push(`%${term.replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
    const n = params.length;
    matches.push(`(i.title ilike $${n} escape '\\' or i.body ilike $${n} escape '\\' or i.author ilike $${n} escape '\\')`);
    scores.push(`(case when i.title ilike $${n} escape '\\' then 4 else 0 end + case when i.author ilike $${n} escape '\\' then 2 else 0 end + case when i.body ilike $${n} escape '\\' then 1 else 0 end)`);
  }
  const ranged = rangePredicate(range,params.length+1); params.push(...ranged.params);
  const rows = await sql.query<Record<string, any>>(`select i.*,s.name as source_name from items i join sources s on s.id=i.source_id
    where (${matches.join(" or ")})${ranged.sql}
    order by (${scores.join(" + ")}) desc,coalesce(i.published_at,i.collected_at) desc,i.id desc limit 40`,params);
  const candidates = rows.map(mapAgentItem);
  return { candidates, items: rankRetrievedItems(query,candidates,Math.min(12,Math.max(1,limit))) };
}
