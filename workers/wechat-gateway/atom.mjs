const escapeText = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value) => escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const cdata = (value) => `<![CDATA[${String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

export function toAtom(sourceId, sourceName, items) {
  const updated = items[0]?.discovered_at ?? items[0]?.published_at ?? new Date(0).toISOString();
  const entries = items.map((item) => `  <entry>
    <id>${escapeText(item.canonical_id)}</id>
    <title>${escapeText(item.title)}</title>
    <published>${escapeText(item.published_at)}</published>
    <updated>${escapeText(item.discovered_at)}</updated>
    <link rel="alternate" href="${escapeAttr(item.original_url)}"/>
    <author><name>${escapeText(item.account_name)}</name></author>
    <content type="html">${cdata(item.body_html ?? item.body_text ?? "")}</content>
${item.cover_url ? `    <media:thumbnail url="${escapeAttr(item.cover_url)}"/>\n` : ""}    <loom:provider>${escapeText(item.provider)}</loom:provider>
    <loom:discovered_at>${escapeText(item.discovered_at)}</loom:discovered_at>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:loom="https://loom.local/ns">
  <id>urn:loom:wechat:${escapeText(sourceId)}</id>
  <title>${escapeText(sourceName)}</title>
  <updated>${escapeText(updated)}</updated>
${entries}
</feed>`;
}
