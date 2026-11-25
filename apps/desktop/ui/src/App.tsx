import { useEffect, useState } from "react";
import type {
  UpdateSettingsRequest,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "./bindings/tauri";
import { ErrorBanner } from "./components/ErrorBanner";
import { Sidebar, type ActiveNavItem } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import {
  loadWorkspaceOverview,
  resetWorkspaceNextcloudUrl,
  saveWorkspaceSettings,
  toUserFacingError,
} from "./lib/workspaceClient";
import { FilesView } from "./views/FilesView";
import { ModuleComingSoonView } from "./views/ModuleComingSoonView";
import { SettingsView } from "./views/SettingsView";

function applyThemePreference(theme: string) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", useDark);
}

export function App() {
  const [overview, setOverview] = useState<WorkspaceOverview_Serialize | null>(
    null,
  );
  const [activeNav, setActiveNav] = useState<ActiveNavItem>("files");
  const [error, setError] = useState<UserFacingError | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaceOverview()
      .then((data) => {
        if (!cancelled) {
          setOverview(data);
          applyThemePreference(data.config.theme);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(toUserFacingError(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!overview) return;
    applyThemePreference(overview.config.theme);

    if (overview.config.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyThemePreference("system");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [overview]);

  async function handleSaveSettings(input: UpdateSettingsRequest) {
    setError(null);
    try {
      const updated = await saveWorkspaceSettings(input);
      setOverview(updated);
    } catch (err) {
      setError(toUserFacingError(err));
      throw err;
    }
  }

  async function handleResetUrl() {
    setError(null);
    try {
      const updated = await resetWorkspaceNextcloudUrl();
      setOverview(updated);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  if (!overview) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
        {error ? (
          <div className="w-full max-w-md">
            <ErrorBanner error={error} />
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Loading workspace...
          </p>
        )}
      </div>
    );
  }

  const activeModule =
    activeNav === "settings"
      ? null
      : overview.modules.find((m) => m.id === activeNav) ?? overview.modules[0];

  const headerTitle =
    activeNav === "settings" ? "Settings" : activeModule?.name ?? "Workspace";
  const headerSubtitle =
    activeNav === "settings"
      ? "Configure your Nextcloud connection, local cache, and integrations."
      : activeModule?.description ?? "";

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        modules={overview.modules}
        activeId={activeNav}
        mcpEnabled={overview.mcpServer.enabled}
        onSelect={(id) => {
          setError(null);
          setActiveNav(id);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBar
          title={headerTitle}
          subtitle={headerSubtitle}
          appVersion={overview.appVersion}
          platform={overview.platform}
          connectionStatus={overview.connectionStatus}
          onOpenSettings={() => setActiveNav("settings")}
        />

        <main className="flex-1 overflow-y-auto p-6">
          {activeNav === "settings" ? (
            <SettingsView
              overview={overview}
              onSave={handleSaveSettings}
              onResetUrl={handleResetUrl}
              error={error}
              onClearError={() => setError(null)}
            />
          ) : activeModule?.id === "files" ? (
            <FilesView
              connectionStatus={overview.connectionStatus}
              onOpenSettings={() => setActiveNav("settings")}
            />
          ) : activeModule ? (
            <ModuleComingSoonView module={activeModule} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
