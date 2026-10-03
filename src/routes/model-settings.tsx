import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Profile = { id: string; name: string; baseURL: string; model: string; keyConfigured: boolean };
type Settings = { activeId: string; profiles: Profile[]; revision: string; editable: boolean; engine: string };
type ActionBody = { action: "save" | "activate" | "delete" | "test"; settings?: Record<string, string>; id?: string; revision?: string };

async function api<T>(body?: ActionBody): Promise<T> {
  const res = await fetch("/api/model-settings", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "无法读取模型设置");
  return data;
}

export const Route = createFileRoute("/model-settings")({ component: ModelSettings });

function ModelSettings() {
  const [notice, setNotice] = useState("");
  const settings = useQuery({ queryKey: ["model-settings"], queryFn: () => api<Settings>(), retry: false });
  return <AppShell title="模型设置" kicker="MODEL SETTINGS">
    <div className="max-w-3xl space-y-6">
      <p className="text-muted">配置同步分析、问答和简报使用的模型。可保存多个本地网关档案（如 10100、8317、7863），一键切换当前使用的模型。API Key 保存在服务端配置文件中，页面不显示密钥。</p>
      {settings.isPending && <p role="status">正在读取配置…</p>}
      {settings.error && <div className="rounded-md border border-border bg-surface p-6 space-y-3"><p role="alert">{settings.error.message}</p><p className="text-muted">先创建 config/model.local.json，填写 Key，再通过本机启动模型设置模式。操作步骤见《本地模型配置指南》。</p><Button onClick={() => void settings.refetch()}>重新读取</Button></div>}
      {notice && <p role="status">{notice}</p>}
      {settings.data && <ProfileList value={settings.data} onNotice={setNotice} />}
    </div>
  </AppShell>;
}

function ProfileList({ value, onNotice }: { value: Settings; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ["model-settings"] }); };
  const done = (message: string) => { setEditing(null); onNotice(message); void refresh(); };
  const revision = value.revision;
  const [testedId, setTestedId] = useState("");
  const activate = useMutation<Settings, Error, string>({ mutationFn: (id: string) => api<Settings>({ action: "activate", revision, settings: { id } }), onSuccess: () => done("已切换当前模型，后续分析、问答、简报使用新档案。") });
  const remove = useMutation<Settings, Error, string>({ mutationFn: (id: string) => api<Settings>({ action: "delete", revision, settings: { id } }), onSuccess: () => done("档案已删除。") });
  const test = useMutation<{ ok: boolean; message: string }, Error, string>({ mutationFn: (id: string) => { setTestedId(id); return api<{ ok: boolean; message: string }>({ action: "test", id }); } });
  const busy = activate.isPending || remove.isPending;
  const engineNote = value.engine === "legacy" ? "当前为同步问答" : "当前使用 Eino；此处配置只作用于同步入口，Eino 仍读取其服务配置。";
  return <section className="space-y-4">
    <div className="rounded-md border border-border bg-surface p-6 space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-2xl">模型档案</h2>
        <span className="text-sm text-muted">{engineNote}</span>
      </div>
      {value.profiles.length === 0 && <p className="text-sm text-muted">尚未保存任何档案，点击下方「新增档案」开始。</p>}
      <ul className="divide-y divide-border">
        {value.profiles.map(profile => {
          const active = profile.id === value.activeId;
          return <li key={profile.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-medium">{profile.name}</span>
              {active ? <Badge tone="live">使用中</Badge> : null}
              {!profile.keyConfigured && <Badge tone="warn">未配置 Key</Badge>}
              {test.data && testedId === profile.id && <span role="status" className="text-sm text-muted">{test.data.message}</span>}
            </div>
            <p className="mt-1 font-mono text-sm text-muted">{profile.baseURL} · {profile.model}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!active && <Button size="sm" disabled={busy || !value.editable} onClick={() => activate.mutate(profile.id)}>设为当前</Button>}
              <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate(profile.id)}>{test.isPending && testedId === profile.id ? "正在测试…" : "测试连接"}</Button>
              <Button size="sm" variant="ghost" disabled={busy || !value.editable} onClick={() => { setEditing(profile); setTestedId(""); }}>编辑</Button>
              <Button size="sm" variant="ghost" disabled={busy || !value.editable || value.profiles.length <= 1} onClick={() => { if (confirm(`删除档案「${profile.name}」？`)) remove.mutate(profile.id); }}>删除</Button>
            </div>
          </li>;
        })}
      </ul>
      {(activate.error || remove.error) && <p role="alert">{activate.error?.message ?? remove.error?.message}</p>}
      <Button disabled={!value.editable || busy} onClick={() => setEditing("new")}>新增档案</Button>
    </div>
    {editing && <ProfileEditor value={value} target={editing} onDone={done} onCancel={() => setEditing(null)} />}
  </section>;
}

function ProfileEditor({ value, target, onDone, onCancel }: { value: Settings; target: Profile | "new"; onDone: (message: string) => void; onCancel: () => void }) {
  const isNew = target === "new";
  const existing: Profile | null = isNew ? null : target;
  const [id] = useState(isNew ? "" : existing!.id);
  const [name, setName] = useState(isNew ? "" : existing!.name);
  const [baseURL, setBaseURL] = useState(isNew ? "" : existing!.baseURL);
  const [model, setModel] = useState(isNew ? "" : existing!.model);
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => api({ action: "save", revision: value.revision, settings: { id, name, baseURL, model, apiKey } }),
    onSuccess: () => onDone(isNew ? "档案已新增。" : "档案已保存，后续同步请求使用新配置。"),
  });
  const invalid = !name.trim() || !baseURL.trim() || !model.trim();
  return <section className="rounded-md border border-border bg-surface p-6 space-y-6">
    <h2 className="font-display text-xl">{isNew ? "新增档案" : `编辑：${existing!.name}`}</h2>
    <div className="space-y-2"><label htmlFor="profile-name">档案名称</label><Input id="profile-name" value={name} onChange={e => setName(e.target.value)} disabled={save.isPending} placeholder="例如 opencodex / cli-proxy / workbuddy" /></div>
    <div className="space-y-2"><label htmlFor="model-url">基础 URL</label><Input id="model-url" value={baseURL} onChange={e => setBaseURL(e.target.value)} disabled={save.isPending} placeholder="http://localhost:10100/v1（本地网关也可用 8317、7863 等端口）" /><p className="text-sm text-muted">填写到 /v1，无需添加 /chat/completions。</p></div>
    <div className="space-y-2"><label htmlFor="model-id">模型 ID</label><Input id="model-id" value={model} onChange={e => setModel(e.target.value)} disabled={save.isPending} placeholder="使用网关模型列表中的完整 ID" /></div>
    <div className="space-y-2"><label htmlFor="model-key">API Key</label><Input id="model-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={save.isPending} placeholder={isNew ? "sk-…" : "留空则保留已保存的 Key"} /><p className="text-sm text-muted">保存在服务端配置文件中，页面不显示、不回显。</p></div>
    <div className="flex flex-wrap gap-3">
      <Button disabled={save.isPending || invalid} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "保存"}</Button>
      <Button variant="ghost" disabled={save.isPending} onClick={onCancel}>取消</Button>
    </div>
    {save.error && <p role="alert">{save.error.message}</p>}
  </section>;
}
