import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  BookOpenText,
  FileText,
  GitBranch,
  Inbox,
  LayoutGrid,
  Library,
  Radio,
  ScanSearch,
  Timer,
  Server,
  Settings,
} from "lucide-react";
import { LoomMark } from "./mark";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "总览", icon: LayoutGrid },
  { to: "/keywords", label: "关键词", icon: ScanSearch },
  { to: "/sources", label: "信源", icon: Radio },
  { to: "/inbox", label: "内容", icon: Inbox },
  { to: "/knowledge", label: "知识库", icon: Library },
  { to: "/jobs", label: "任务", icon: Timer },
  { to: "/nodes", label: "节点", icon: Server },
  { to: "/model-settings", label: "模型设置", icon: Settings },
  { to: "/pipeline", label: "管道", icon: GitBranch },
  { to: "/guide", label: "指南", icon: BookOpenText },
  { to: "/prd", label: "规格", icon: FileText },
] as const;

const MOBILE = NAV.filter((n) =>
  ["/", "/keywords", "/inbox", "/knowledge", "/sources"].includes(n.to),
);

function usePath() {
  return useRouterState({ select: (s) => s.location.pathname });
}

function isActive(path: string, to: string) {
  if (to === "/") return path === "/";
  return path === to || path.startsWith(`${to}/`);
}

export function AppShell({
  title,
  kicker,
  action,
  children,
  cinema,
}: {
  title: string;
  kicker?: string;
  action?: ReactNode;
  children: ReactNode;
  cinema?: boolean;
}) {
  const path = usePath();
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-white/10 bg-bg px-4 py-6 lg:flex">
        <Link to="/" className="mb-8 flex items-center gap-2.5 px-2 text-fg">
          <LoomMark className="size-7 text-accent" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-xl tracking-tight">织识</span>
            <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
              Loom
            </span>
          </span>
        </Link>
        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(path, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-sm px-3 text-sm transition-colors duration-150",
                  active ? "bg-raised text-fg" : "text-muted hover:bg-raised/70 hover:text-fg",
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <p className="px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
          关键词 · 增量采集
        </p>
      </aside>

      <div className="lg:pl-56">
        <header
          className={cn(
            "z-10 flex items-center justify-between gap-3 px-4 py-3 lg:px-8",
            cinema
              ? "absolute inset-x-0 top-0 border-b border-white/10 bg-transparent"
              : "sticky top-0 border-b border-border bg-bg/90 backdrop-blur-sm",
          )}
        >
          <div className="flex min-w-0 items-center gap-3 lg:hidden">
            <LoomMark className="size-6 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="font-display text-lg leading-none">织识</p>
              <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                {kicker ?? "Loom"}
              </p>
            </div>
          </div>
          <div className={cn("hidden min-w-0 lg:block", cinema && "lg:hidden")}>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              {kicker ?? "Media Matrix"}
            </p>
            <h1 className="font-display text-2xl leading-tight tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          </div>
          <div className="ml-auto flex items-center gap-2"><Link to="/model-settings" aria-label="模型设置" className="p-3 lg:hidden"><Settings className="size-5" /></Link>{action}</div>
        </header>

        <main className={cn(cinema ? "pb-24 lg:pb-0" : "px-4 pb-28 pt-5 lg:px-8 lg:pb-12 lg:pt-8")}>
          {cinema ? null : (
            <div className="mb-5 lg:hidden">
              <h1 className="font-display text-3xl tracking-tight [overflow-wrap:anywhere]">{title}</h1>
            </div>
          )}
          {children}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden">
        <div className="grid grid-cols-5">
          {MOBILE.map((item) => {
            const Icon = item.icon;
            const active = isActive(path, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 text-[10px]",
                  active ? "text-fg" : "text-muted",
                )}
              >
                <Icon className="size-4" strokeWidth={active ? 2 : 1.7} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
