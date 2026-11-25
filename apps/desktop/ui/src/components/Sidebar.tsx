import {
  Blocks,
  Cpu,
  Folder,
  Settings,
  Wallet,
  Workflow,
} from "lucide-react";
import type { ModuleDescriptor } from "../bindings/tauri";

export type ActiveNavItem = string | "settings";

interface SidebarProps {
  modules: ModuleDescriptor[];
  activeId: ActiveNavItem;
  mcpEnabled: boolean;
  onSelect: (id: ActiveNavItem) => void;
}

function ModuleIcon({ icon }: { icon: string }) {
  switch (icon) {
    case "folder":
      return <Folder className="h-4 w-4 shrink-0" />;
    case "wallet":
      return <Wallet className="h-4 w-4 shrink-0" />;
    case "workflow":
      return <Workflow className="h-4 w-4 shrink-0" />;
    default:
      return <Blocks className="h-4 w-4 shrink-0" />;
  }
}

export function Sidebar({
  modules,
  activeId,
  mcpEnabled,
  onSelect,
}: SidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex h-14 items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold tracking-tight text-white shadow-sm">
          FR
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            FR Universal App
          </p>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            Team Workspace
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Workspace modules">
        <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
          Workspace
        </p>
        {modules.map((mod) => {
          const isActive = activeId === mod.id;
          return (
            <button
              key={mod.id}
              type="button"
              onClick={() => onSelect(mod.id)}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/80"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <ModuleIcon icon={mod.icon} />
                <span className="truncate">{mod.name}</span>
              </span>
              {mod.status !== "active" && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Soon
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="flex items-center gap-2 font-medium">
            <Cpu className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
            Local MCP
          </span>
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
              mcpEnabled
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                mcpEnabled ? "bg-emerald-500" : "bg-slate-400"
              }`}
            />
            {mcpEnabled ? "Enabled" : "Off"}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onSelect("settings")}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors ${
            activeId === "settings"
              ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
              : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/80"
          }`}
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
