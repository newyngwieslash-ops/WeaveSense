import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Settings = { baseURL: string; model: string; revision: string; keyConfigured: boolean; editable: boolean; engine: string };
async function api<T>(body?: unknown): Promise<T> {
  const res = await fetch("/api/model-settings", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "无法读取模型设置");
  return data;
}
export const Route = createFileRoute("/model-settings")({ component: ModelSettings });
function ModelSettings() {
  const [notice, setNotice] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const settings = useQuery({ queryKey: ["model-settings"], queryFn: () => api<Settings>(), retry: false });
  const reload = async () => {
    const result = await settings.refetch();
    if (!result.isError) setReloadVersion(n => n + 1);
  };
  return <AppShell title="模型设置" kicker="MODEL SETTINGS">
    <div className="max-w-3xl space-y-6">
      <p className="text-muted">配置同步分析、问答和简报使用的模型。API Key 由你在服务端文件中填写。</p>
      {settings.isPending && <p role="status">正在读取配置…</p>}
      {settings.error && <div className="rounded-md border border-border bg-surface p-6 space-y-3"><p role="alert">{settings.error.message}</p><p className="text-muted">先创建 config/model.local.json，填写 Key，再通过本机启动模型设置模式。操作步骤见《本地模型配置指南》。</p><Button onClick={() => void settings.refetch()}>重新读取</Button></div>}
      {notice && <p role="status">{notice}</p>}
      {settings.data && <SettingsForm key={`${settings.data.revision}:${reloadVersion}`} value={settings.data} refresh={() => void reload()} saved={() => setNotice("已保存，后续同步请求使用新配置。")} />}
    </div>
  </AppShell>;
}
function SettingsForm({ value, refresh, saved }: { value: Settings; refresh: () => void; saved: () => void }) {
  const [baseURL, setBaseURL] = useState(value.baseURL);
  const [model, setModel] = useState(value.model);
  const save = useMutation({ mutationFn: () => api<Settings>({ action: "save", settings: { baseURL, model, revision: value.revision } }), onSuccess: () => { saved(); refresh(); } });
  const check = useMutation({ mutationFn: () => api<{ ok: boolean; message: string }>({ action: "test" }) });
  const dirty = baseURL !== value.baseURL || model !== value.model;
  const busy = save.isPending || check.isPending;
  return <section className="rounded-md border border-border bg-surface p-6 space-y-6">
    <div><h2 className="font-display text-2xl">OpenAI 兼容接口</h2><p className="mt-2 text-sm text-muted">{value.engine === "legacy" ? "当前为同步问答" : "当前使用 Eino；此处配置只作用于同步入口，Eino 仍读取其服务配置。"}</p></div>
    <div className="space-y-2"><label htmlFor="model-url">基础 URL</label><Input id="model-url" value={baseURL} onChange={e => setBaseURL(e.target.value)} disabled={busy} placeholder="http://localhost:10100/v1" /><p className="text-sm text-muted">填写到 /v1，无需添加 /chat/completions。</p></div>
    <div className="space-y-2"><label htmlFor="model-id">模型 ID</label><Input id="model-id" value={model} onChange={e => setModel(e.target.value)} disabled={busy} /><p className="text-sm text-muted">使用网关模型列表中的完整 ID。</p></div>
    <div><p>API Key：{value.keyConfigured ? "已配置" : "未配置"}</p><p className="mt-2 text-sm text-muted">在 config/model.local.json 的 apiKey 中填写。页面不显示密钥。</p></div>
    <p className="text-sm text-muted">配置版本：<span className="font-mono">{value.revision.slice(0, 12)}</span></p>
    <div className="flex flex-wrap gap-3"><Button disabled={!value.editable || busy || !baseURL.trim() || !model.trim() || !dirty} onClick={() => save.mutate()}>保存设置</Button><Button variant="outline" disabled={busy || dirty || !value.keyConfigured} onClick={() => check.mutate()}>{check.isPending ? "正在检查…" : "测试连接"}</Button><Button variant="ghost" disabled={busy} onClick={refresh}>重新读取</Button></div>
    <p className="text-sm text-muted">测试只读取已保存配置的模型列表，不生成内容。保存不会开启后台研究或自动分析。</p>
    {(save.error || check.error) && <p role="alert">{save.error?.message ?? check.error?.message}</p>}
    {check.data && <p role="status">{check.data.message}</p>}
  </section>;
}
