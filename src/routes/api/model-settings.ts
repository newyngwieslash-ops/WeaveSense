import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { modelSettings, saveModelSettings, checkModelConnection, localModelAccess } from "@/lib/server/model-config";

async function handle(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!localModelAccess(request, getRequestIP({ xForwardedFor: false }))) return Response.json({ error: "模型管理仅支持已配置的本机访问" }, { status: 403, headers });
  try {
    if (request.method === "GET") return Response.json(modelSettings(), { headers });
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
    const raw = await request.text();
    if (raw.length > 4096) throw new Error();
    const input = JSON.parse(raw);
    if (input.action === "test" && Object.keys(input).length === 1) return Response.json(await checkModelConnection(), { headers });
    if (input.action !== "save" || Object.keys(input).sort().join(",") !== "action,settings") throw new Error();
    return Response.json(saveModelSettings(input.settings), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = ["模型配置无效，请检查服务端配置文件", "配置正在保存，请稍后重试", "配置已被修改，请刷新后重新编辑"].includes(message);
    return Response.json({ error: safe ? message : "无法处理配置，请检查文件和权限" }, { status: 400, headers });
  }
}
export const Route = createFileRoute("/api/model-settings")({ server: { handlers: {
  GET: ({ request }) => handle(request), POST: ({ request }) => handle(request),
} } });
