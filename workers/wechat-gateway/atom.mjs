// Stripping XML-1.0-illegal control characters is the point of this line, so the
// control-character rule is disabled for it specifically (with the reason stated
// rather than blanket-silencing the rule for the file).
// eslint-disable-next-line no-control-regex -- intentional: these characters are invalid in XML 1.0
const xmlText = (value) => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const escapeText = (value) => xmlText(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value) => escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const cdata = (value) => `<![CDATA[${xmlText(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

function providersSeen(item) {
  let seen = [];
  try {
    const parsed = typeof item.providers_seen === "string"
      ? JSON.parse(item.providers_seen) : item.providers_seen;
    if (Array.isArray(parsed)) seen = parsed;
  } catch {
    seen = String(item.providers_seen ?? "").split(",");
  }
  return [...new Set([...seen, item.provider]
    .map((provider) => String(provider ?? "").trim()).filter(Boolean))].join(",");
}

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
    <loom:providers_seen>${escapeText(providersSeen(item))}</loom:providers_seen>
    <loom:discovered_at>${escapeText(item.discovered_at)}</loom:discovered_at>
    <loom:body_complete>${String(Boolean(item.body_complete))}</loom:body_complete>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:loom="https://loom.local/ns">
  <id>urn:loom:wechat:${escapeText(sourceId)}</id>
  <title>${escapeText(sourceName)}</title>
  <updated>${escapeText(updated)}</updated>
${items[0]?.primary_content_at ? `  <loom:primary_content_at>${escapeText(items[0].primary_content_at)}</loom:primary_content_at>\n` : ''}
${entries}
</feed>`;
}
