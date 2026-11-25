import { Cloud, CloudOff, Settings2 } from "lucide-react";
import type { NextcloudConnectionStatus } from "../bindings/tauri";

interface StatusBarProps {
  title: string;
  subtitle: string;
  appVersion: string;
  platform: string;
  connectionStatus: NextcloudConnectionStatus;
  onOpenSettings: () => void;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function StatusBar({
  title,
  subtitle,
  appVersion,
  platform,
  connectionStatus,
  onOpenSettings,
}: StatusBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 dark:border-slate-800 dark:bg-slate-900">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h1>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
          {subtitle}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          {connectionStatus.state === "connected" ? (
            <>
              <Cloud className="h-3.5 w-3.5 text-emerald-500" />
              <span>{connectionStatus.loginName}</span>
            </>
          ) : connectionStatus.state === "signedOut" ? (
            <>
              <Cloud className="h-3.5 w-3.5 text-amber-500" />
              <span>{hostLabel(connectionStatus.serverUrl)} · Sign in</span>
            </>
          ) : (
            <>
              <CloudOff className="h-3.5 w-3.5 text-slate-400" />
              <span>Set Nextcloud server</span>
              <Settings2 className="h-3 w-3 text-slate-400" />
            </>
          )}
        </button>

        <span className="hidden rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500 sm:inline-block dark:bg-slate-800 dark:text-slate-400">
          v{appVersion} · {platform}
        </span>
      </div>
    </header>
  );
}
