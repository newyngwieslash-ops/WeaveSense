import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { modelSettings, upsertModelProfile, activateModelProfile, deleteModelProfile, checkProfileConnection, localModelAccess } from "@/lib/server/model-config";

async function handle(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!localModelAccess(request, getRequestIP({ xForwardedFor: false }))) return Response.json({ error: "模型管理仅支持已配置的本机访问" }, { status: 403, headers });
  try {
    if (request.method === "GET") return Response.json(modelSettings(), { headers });
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
    const raw = await request.text();
    if (raw.length > 16384) throw new Error();
    const input = JSON.parse(raw) as { action?: string; id?: string; revision?: unknown; settings?: Record<string, unknown> };
    if (input.action === "test" && typeof input.id === "string" && Object.keys(input).length === 2) return Response.json(await checkProfileConnection(input.id), { headers });
    if (typeof input.revision !== "string") throw new Error();
    const revision: string = input.revision;
    const settings = (input.settings ?? {}) as Record<string, string>;
    const keys = Object.keys(settings).sort().join(",");
    if (input.action === "save" && keys === "apiKey,baseURL,id,model,name") {
      return Response.json(upsertModelProfile({ ...settings, revision }), { headers });
    }
    if (input.action === "activate" && keys === "id") {
      return Response.json(activateModelProfile({ id: String(settings.id), revision }), { headers });
    }
    if (input.action === "delete" && keys === "id") {
      return Response.json(deleteModelProfile({ id: String(settings.id), revision }), { headers });
    }
    throw new Error();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = ["模型配置无效，请检查服务端配置文件", "配置正在保存，请稍后重试", "配置已被修改，请刷新后重新编辑",
      "至少保留一个模型档案", "档案不存在，请刷新后重试"].includes(message) || /^最多保存 \d+ 个模型档案$/.test(message);
    return Response.json({ error: safe ? message : "无法处理配置，请检查文件和权限" }, { status: 400, headers });
  }
}
export const Route = createFileRoute("/api/model-settings")({ server: { handlers: {
  GET: ({ request }) => handle(request), POST: ({ request }) => handle(request),
} } });
