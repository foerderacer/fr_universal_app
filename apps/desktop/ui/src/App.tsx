import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUpdateCheckResult_Serialize,
  PendingWriteApproval,
  UpdateSettingsRequest,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "./bindings/tauri";
import { ErrorBanner } from "./components/ErrorBanner";
import { Sidebar, type ActiveNavItem } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { UpdateBanner } from "./components/update/UpdateBanner";
import { UpdateDialog } from "./components/update/UpdateDialog";
import { listPendingMcpApprovals, resolveMcpApproval } from "./lib/mcpClient";
import {
  cancelNextcloudLogin,
  loadWorkspaceOverview,
  pollNextcloudLogin,
  refreshAccountInfo,
  resetWorkspaceNextcloudUrl,
  saveWorkspaceSettings,
  signOutNextcloud,
  skipAppUpdate,
  startNextcloudLogin,
  toUserFacingError,
} from "./lib/workspaceClient";
import { AutomationsView } from "./views/AutomationsView";
import { FilesView } from "./views/FilesView";
import { FinanceView } from "./views/FinanceView";
import { McpView } from "./views/McpView";
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
  const [loginPendingUrl, setLoginPendingUrl] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [pendingMcpApprovals, setPendingMcpApprovals] = useState<
    PendingWriteApproval[]
  >([]);
  const [availableUpdate, setAvailableUpdate] =
    useState<AppUpdateCheckResult_Serialize | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<AppUpdateCheckResult_Serialize>(
      "app://update-available",
      (event) => {
        if (event.payload.available && !event.payload.skipped) {
          setAvailableUpdate(event.payload);
          setUpdateBannerDismissed(false);
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function handleSkipUpdateVersion(version: string) {
    try {
      const updated = await skipAppUpdate(version);
      setOverview(updated);
      setAvailableUpdate(null);
      setUpdateDialogOpen(false);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  const refreshPendingApprovals = useCallback(() => {
    void listPendingMcpApprovals()
      .then(setPendingMcpApprovals)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!overview?.mcpServer.enabled) {
      setPendingMcpApprovals([]);
      return;
    }
    refreshPendingApprovals();
    const timer = window.setInterval(refreshPendingApprovals, 1500);
    return () => window.clearInterval(timer);
  }, [overview?.mcpServer.enabled, refreshPendingApprovals]);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaceOverview()
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        setLoginPendingUrl(data.loginPendingUrl);
        applyThemePreference(data.config.theme);

        // Silently populate account display name & quota when a keychain session was restored.
        if (
          data.connectionStatus.state === "connected" &&
          data.accountInfo === null
        ) {
          void refreshAccountInfo()
            .then((info) => {
              if (!cancelled && info) {
                setOverview((prev) =>
                  prev ? { ...prev, accountInfo: info } : prev,
                );
              }
            })
            .catch(() => {
              // Non-fatal: user may be offline.
            });
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

  // Poll Nextcloud Login Flow v2 every 2 seconds while waiting for browser approval,
  // with a 10-minute expiration timeout so abandoned flows clean up gracefully.
  useEffect(() => {
    if (!loginPendingUrl) return;
    let cancelled = false;
    const startedAt = Date.now();
    const MAX_LOGIN_WAIT_MS = 10 * 60 * 1000;

    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > MAX_LOGIN_WAIT_MS) {
        setLoginPendingUrl(null);
        void cancelNextcloudLogin().catch(() => {});
        setError({
          code: "login_expired",
          title: "Sign-in session timed out",
          message: "The browser sign-in link expired before approval completed.",
          recoveryHint: "Click Sign in with Nextcloud to open a fresh sign-in link.",
          technicalDetails: null,
        });
        return;
      }

      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      void pollNextcloudLogin()
        .then((res) => {
          if (cancelled) return;
          if (res.completed && res.overview) {
            setLoginPendingUrl(null);
            setOverview(res.overview);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setLoginPendingUrl(null);
            void cancelNextcloudLogin().catch(() => {});
            setError(toUserFacingError(err));
          }
        })
        .finally(() => {
          pollInFlightRef.current = false;
        });
    }, 2000);

    return () => {
      cancelled = true;
      pollInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [loginPendingUrl]);

  async function handleSaveSettings(input: UpdateSettingsRequest) {
    setError(null);
    try {
      const updated = await saveWorkspaceSettings(input);
      setOverview(updated);
      if (updated.connectionStatus.state !== "connected") {
        setLoginPendingUrl(null);
      }
    } catch (err) {
      setError(toUserFacingError(err));
      throw err;
    }
  }

  async function handleResetUrl(): Promise<string> {
    setError(null);
    try {
      const updated = await resetWorkspaceNextcloudUrl();
      setOverview(updated);
      if (updated.connectionStatus.state !== "connected") {
        setLoginPendingUrl(null);
      }
      return updated.config.nextcloudUrl;
    } catch (err) {
      setError(toUserFacingError(err));
      throw err;
    }
  }

  async function handleStartLogin() {
    setError(null);
    setLoginStarting(true);
    try {
      const res = await startNextcloudLogin();
      setLoginPendingUrl(res.loginUrl);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoginStarting(false);
    }
  }

  async function handleCancelLogin() {
    setError(null);
    setLoginPendingUrl(null);
    try {
      const updated = await cancelNextcloudLogin();
      setOverview(updated);
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function handleSignOut() {
    setError(null);
    setLoginPendingUrl(null);
    try {
      const updated = await signOutNextcloud();
      setOverview(updated);
    } catch (err) {
      setError(toUserFacingError(err));
      throw err;
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
      : (overview.modules.find((m) => m.id === activeNav) ??
        overview.modules[0]);

  const headerTitle =
    activeNav === "settings" ? "Settings" : (activeModule?.name ?? "Workspace");
  const headerSubtitle =
    activeNav === "settings"
      ? "Configure your Nextcloud connection, local cache, and integrations."
      : (activeModule?.description ?? "");

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        modules={overview.modules}
        activeId={activeNav}
        mcpEnabled={overview.mcpServer.enabled}
        pendingMcpApprovals={pendingMcpApprovals.length}
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
          accountInfo={overview.accountInfo}
          onOpenSettings={() => setActiveNav("settings")}
        />

        <main className="flex-1 overflow-y-auto p-6">
          {availableUpdate &&
            availableUpdate.available &&
            !updateBannerDismissed && (
              <UpdateBanner
                update={availableUpdate}
                onReviewUpdate={() => setUpdateDialogOpen(true)}
                onDismissLater={() => setUpdateBannerDismissed(true)}
                onSkipVersion={(ver) => void handleSkipUpdateVersion(ver)}
              />
            )}
          {overview.startupError && (
            <div className="mx-auto mb-4 max-w-4xl">
              <ErrorBanner error={overview.startupError} />
            </div>
          )}
          {pendingMcpApprovals.length > 0 && activeModule?.id !== "mcp" && (
            <div
              role="alertdialog"
              className="mx-auto mb-4 max-w-5xl rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 shadow-xs dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    <strong>AI write request:</strong>{" "}
                    <code>{pendingMcpApprovals[0].toolName}</code> —{" "}
                    {pendingMcpApprovals[0].summary}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void resolveMcpApproval(
                        pendingMcpApprovals[0].id,
                        true,
                      ).then(refreshPendingApprovals)
                    }
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 font-semibold text-white hover:bg-emerald-700"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Allow
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void resolveMcpApproval(
                        pendingMcpApprovals[0].id,
                        false,
                      ).then(refreshPendingApprovals)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300"
                  >
                    <X className="h-3.5 w-3.5" />
                    Deny
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeNav === "settings" ? (
            <SettingsView
              overview={overview}
              onSave={handleSaveSettings}
              onResetUrl={handleResetUrl}
              onSignOut={handleSignOut}
              onOverviewUpdated={setOverview}
              onOpenUpdateDialog={(upd) => {
                setAvailableUpdate(upd);
                setUpdateDialogOpen(true);
              }}
              error={error}
              onClearError={() => setError(null)}
            />
          ) : activeModule?.id === "files" ? (
            <FilesView
              connectionStatus={overview.connectionStatus}
              accountInfo={overview.accountInfo}
              pinnedFolders={overview.config.pinnedFolders}
              loginPendingUrl={loginPendingUrl}
              loginStarting={loginStarting}
              error={error}
              onClearError={() => setError(null)}
              onStartLogin={handleStartLogin}
              onCancelLogin={handleCancelLogin}
              onOpenSettings={() => setActiveNav("settings")}
              onOverviewUpdated={setOverview}
            />
          ) : activeModule?.id === "mcp" ? (
            <McpView
              isNextcloudConnected={overview.connectionStatus.state === "connected"}
              pendingApprovals={pendingMcpApprovals}
              onRefreshApprovals={refreshPendingApprovals}
              onOverviewUpdated={setOverview}
            />
          ) : activeModule?.id === "finance" ? (
            <FinanceView
              financeFolder={overview.config.financeFolder}
              isNextcloudConnected={overview.connectionStatus.state === "connected"}
              onOverviewUpdated={setOverview}
            />
          ) : activeModule?.id === "automation" ? (
            <AutomationsView
              isNextcloudConnected={overview.connectionStatus.state === "connected"}
            />
          ) : activeModule ? (
            <ModuleComingSoonView module={activeModule} />
          ) : null}
        </main>
      </div>
      {updateDialogOpen && availableUpdate && (
        <UpdateDialog
          update={availableUpdate}
          onClose={() => setUpdateDialogOpen(false)}
          onSkipVersion={(ver) => void handleSkipUpdateVersion(ver)}
        />
      )}
    </div>
  );
}
