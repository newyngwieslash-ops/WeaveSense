import { timingSafeEqual } from "node:crypto";

export function tokenOk(got: string, want: string): boolean {
  if (!got || !want) return false;
  const actual = Buffer.from(got);
  const expected = Buffer.from(want);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type AgentJson = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

// Call only after service authentication. Bound bytes before decoding or joining.
export async function readAgentJson(request: Request, maxBytes: number): Promise<AgentJson> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("invalid body limit");
  const rejected = (status: number): AgentJson => ({ ok: false, response: Response.json({ error: status === 413 ? "too_large" : "invalid_request" }, { status }) });
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return rejected(400);
    if (Number(length) > maxBytes) {
      void request.body?.cancel().catch(() => {});
      return rejected(413);
    }
  }
  if (!request.body) return rejected(400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - size) {
        void reader.cancel().catch(() => {});
        return rejected(413);
      }
      size += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    const value: unknown = JSON.parse(parts.join(""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return rejected(400);
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    void reader.cancel().catch(() => {});
    return rejected(400);
  } finally {
    reader.releaseLock();
  }
}
