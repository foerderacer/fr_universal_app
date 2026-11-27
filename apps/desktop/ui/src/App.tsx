import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AppUpdateCheckResult_Serialize,
  PendingWriteApproval,
  UpdateSettingsRequest,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "./bindings/tauri";
import { ErrorBanner } from "./components/ErrorBanner";
import {
  ModuleRail,
  type ActiveNavItem,
} from "./components/shell/ModuleRail";
import { QuickChatDrawer } from "./components/shell/QuickChatDrawer";
import { InlineDeleteConfirm } from "./components/ui/InlineDeleteConfirm";
import { UpdateBanner } from "./components/update/UpdateBanner";
import { UpdateDialog } from "./components/update/UpdateDialog";
import { listPendingMcpApprovals, resolveMcpApproval } from "./lib/mcpClient";
import { IS_MAC_PLATFORM } from "./lib/platform";
import { syncQuickChatAccount } from "./lib/quickChatStore";
import {
  areSingleKeyShortcutsEnabled,
  hasActiveOverlay,
  isEditableTarget,
} from "./lib/shortcuts";
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
import { TalkView } from "./views/TalkView";

const SlicerView = lazy(() =>
  import("./views/SlicerView").then((m) => ({ default: m.SlicerView })),
);

const THEME_STORAGE_KEY = "fr.workspace.theme.v1";

function applyThemePreference(theme: string) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", useDark);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors in restricted webviews.
  }
}

const PANE_STATE_KEY = "fr.workspace.paneState.v1";

interface ModulePaneState {
  sidebar: boolean;
  inspector: boolean;
}

function readPaneStateMap(): Record<string, ModulePaneState> {
  try {
    const raw = window.localStorage.getItem(PANE_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, ModulePaneState>;
    }
  } catch {
    // Ignore storage errors in restricted webviews.
  }
  return {};
}

function persistPaneStateMap(map: Record<string, ModulePaneState>) {
  try {
    window.localStorage.setItem(PANE_STATE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors.
  }
}

function defaultPaneFor(moduleId: string): ModulePaneState {
  // Files and Finance default inspector closed to avoid empty placeholder chrome until an item is selected
  return {
    sidebar: true,
    inspector: moduleId !== "finance" && moduleId !== "files",
  };
}

export function App() {
  const [overview, setOverview] = useState<WorkspaceOverview_Serialize | null>(
    null,
  );
  const [activeNav, setActiveNav] = useState<ActiveNavItem>("files");
  const [paneStateByModule, setPaneStateByModule] = useState<
    Record<string, ModulePaneState>
  >(() => readPaneStateMap());
  const [quickChatOpen, setQuickChatOpen] = useState(false);

  const currentPane =
    paneStateByModule[activeNav] ?? defaultPaneFor(activeNav);
  const sidebarOpen = currentPane.sidebar;
  const inspectorOpen = currentPane.inspector;

  const setSidebarOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setPaneStateByModule((prevMap) => {
        const cur = prevMap[activeNav] ?? defaultPaneFor(activeNav);
        const value = typeof next === "function" ? next(cur.sidebar) : next;
        const updated = {
          ...prevMap,
          [activeNav]: { ...cur, sidebar: value },
        };
        persistPaneStateMap(updated);
        return updated;
      });
    },
    [activeNav],
  );

  const setInspectorOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setPaneStateByModule((prevMap) => {
        const cur = prevMap[activeNav] ?? defaultPaneFor(activeNav);
        const value = typeof next === "function" ? next(cur.inspector) : next;
        const updated = {
          ...prevMap,
          [activeNav]: { ...cur, inspector: value },
        };
        persistPaneStateMap(updated);
        return updated;
      });
    },
    [activeNav],
  );

  const [error, setError] = useState<UserFacingError | null>(null);
  const [loginPendingUrl, setLoginPendingUrl] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [pendingMcpApprovals, setPendingMcpApprovals] = useState<
    PendingWriteApproval[]
  >([]);
  const [armedApprovalId, setArmedApprovalId] = useState<string | null>(null);
  const focusRestoreRef = useRef<
    Record<string, { sidebar: boolean; inspector: boolean; quickChat: boolean }>
  >({});
  const [availableUpdate, setAvailableUpdate] =
    useState<AppUpdateCheckResult_Serialize | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const pollInFlightRef = useRef(false);

  // Global keyboard shortcuts matching tooltip hints
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hasActiveOverlay()) {
        return;
      }
      const inInput = isEditableTarget(e.target);

      // Pane collapse toggles ([ / ]). On macOS, module navigation uses ⌘ so Option+5/6 ([ / ])
      // on German/French layouts never collide with Automations / MCP shortcuts.
      if (
        areSingleKeyShortcutsEnabled() &&
        !inInput &&
        !e.metaKey &&
        (!e.ctrlKey || e.altKey) &&
        (e.key === "[" || e.key === "]")
      ) {
        if (e.key === "[") {
          const sidebarBtn = document.querySelector<HTMLButtonElement>(
            'button[data-sidebar-toggle="true"]',
          );
          if (!sidebarBtn || sidebarBtn.disabled) return;
          e.preventDefault();
          setSidebarOpen((prev) => !prev);
          return;
        }
        if (quickChatOpen) {
          e.preventDefault();
          setQuickChatOpen(false);
          return;
        }
        const inspectorBtn = document.querySelector<HTMLButtonElement>(
          'button[data-inspector-toggle="true"]',
        );
        if (!inspectorBtn || inspectorBtn.disabled) return;
        e.preventDefault();
        setInspectorOpen((prev) => !prev);
        return;
      }

      const navModPressed = IS_MAC_PLATFORM
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

      // Allow Quick Chat toggle even while focus is inside the Quick Chat composer
      if (navModPressed) {
        const isQuickChatKey = IS_MAC_PLATFORM
          ? e.code === "KeyJ" || e.key.toLowerCase() === "j"
          : e.code === "KeyC" || e.key.toLowerCase() === "c";
        if (isQuickChatKey) {
          e.preventDefault();
          if (activeNav === "talk") return;
          setQuickChatOpen((prev) => !prev);
          return;
        }
      }

      if (navModPressed && !inInput) {
        if (e.code === "Digit1" || e.code === "Numpad1" || e.key === "1") {
          e.preventDefault();
          setActiveNav("files");
          return;
        }
        if (e.code === "Digit2" || e.code === "Numpad2" || e.key === "2") {
          e.preventDefault();
          setActiveNav("finance");
          return;
        }
        if (e.code === "Digit3" || e.code === "Numpad3" || e.key === "3") {
          e.preventDefault();
          setActiveNav("slicer");
          return;
        }
        if (e.code === "Digit4" || e.code === "Numpad4" || e.key === "4") {
          e.preventDefault();
          setActiveNav("talk");
          setQuickChatOpen(false);
          return;
        }
        if (e.code === "Digit5" || e.code === "Numpad5" || e.key === "5") {
          e.preventDefault();
          setActiveNav("automation");
          return;
        }
        if (e.code === "Digit6" || e.code === "Numpad6" || e.key === "6") {
          e.preventDefault();
          setActiveNav("mcp");
          return;
        }
        // Match on character key "," so AZERTY physical Comma (";") does not trigger Settings
        if (e.key === ",") {
          e.preventDefault();
          setActiveNav("settings");
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        // Respect rich-text editors (e.g. Markdown Bold), formatting toolbars, and already-handled keystrokes
        if (
          inInput ||
          e.defaultPrevented ||
          Boolean(document.activeElement?.closest('[role="toolbar"]'))
        ) {
          return;
        }
        const sidebarBtn = document.querySelector<HTMLButtonElement>(
          'button[data-sidebar-toggle="true"]',
        );
        if (!sidebarBtn || sidebarBtn.disabled) return;
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
        return;
      }

      if (
        areSingleKeyShortcutsEnabled() &&
        !inInput &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (e.key.toLowerCase() === "f" && activeNav !== "slicer") {
          // Universal single-module Focus Mode (Slicer manages its own viewport F handler)
          const sidebarBtn = document.querySelector<HTMLButtonElement>(
            'button[data-sidebar-toggle="true"]',
          );
          const inspectorBtn = document.querySelector<HTMLButtonElement>(
            'button[data-inspector-toggle="true"]',
          );
          const canToggleSidebar = Boolean(sidebarBtn && !sidebarBtn.disabled);
          const canToggleInspector = Boolean(
            inspectorBtn && !inspectorBtn.disabled,
          );
          if (!canToggleSidebar && !canToggleInspector && !quickChatOpen) return;
          e.preventDefault();
          const currentlyFocused =
            (!canToggleSidebar || !sidebarOpen) &&
            (!canToggleInspector || !inspectorOpen) &&
            !quickChatOpen;
          if (currentlyFocused) {
            const saved = focusRestoreRef.current[activeNav];
            setSidebarOpen(saved ? saved.sidebar : true);
            if (canToggleInspector) {
              setInspectorOpen(saved ? saved.inspector : false);
            }
            if (saved?.quickChat && activeNav !== "talk") {
              setQuickChatOpen(true);
            }
          } else {
            focusRestoreRef.current[activeNav] = {
              sidebar: sidebarOpen,
              inspector: inspectorOpen,
              quickChat: quickChatOpen,
            };
            if (canToggleSidebar) setSidebarOpen(false);
            if (canToggleInspector) setInspectorOpen(false);
            if (quickChatOpen) setQuickChatOpen(false);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    quickChatOpen,
    activeNav,
    sidebarOpen,
    inspectorOpen,
    setSidebarOpen,
    setInspectorOpen,
  ]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<AppUpdateCheckResult_Serialize>(
      "app://update-available",
      (event) => {
        if (!cancelled && event.payload.available && !event.payload.skipped) {
          setAvailableUpdate(event.payload);
          setUpdateBannerDismissed(false);
        }
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
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
            .catch(() => {});
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
          recoveryHint: "Click Sign in to open a fresh sign-in link.",
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
      if (updated.connectionStatus.state !== "connected") {
        syncQuickChatAccount(null);
        setLoginPendingUrl(null);
      }
      setOverview(updated);
    } catch (err) {
      setError(toUserFacingError(err));
      throw err;
    }
  }

  async function handleResetUrl(): Promise<string> {
    setError(null);
    try {
      const updated = await resetWorkspaceNextcloudUrl();
      if (updated.connectionStatus.state !== "connected") {
        syncQuickChatAccount(null);
        setLoginPendingUrl(null);
      }
      setOverview(updated);
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

  const quickChatAccountKey =
    overview?.connectionStatus.state === "connected"
      ? `${overview.connectionStatus.serverUrl}|${overview.connectionStatus.loginName}`
      : null;

  useEffect(() => {
    syncQuickChatAccount(quickChatAccountKey);
  }, [quickChatAccountKey]);

  async function handleSignOut() {
    setError(null);
    setLoginPendingUrl(null);
    syncQuickChatAccount(null);
    try {
      const updated = await signOutNextcloud();
      setOverview(updated);
    } catch (err) {
      syncQuickChatAccount(quickChatAccountKey);
      setError(toUserFacingError(err));
      throw err;
    }
  }

  if (!overview) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-app)] p-6">
        <h1 className="sr-only">FR Universal App</h1>
        {error ? (
          <div className="w-full max-w-md">
            <ErrorBanner error={error} />
          </div>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Loading workspace…
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

  const isNextcloudConnected = overview.connectionStatus.state === "connected";

  const handleToggleInspector = () => {
    if (quickChatOpen) {
      setQuickChatOpen(false);
    } else {
      setInspectorOpen((prev) => !prev);
    }
  };

  const quickChatDrawerNode =
    quickChatOpen && activeModule?.id !== "talk" ? (
      <QuickChatDrawer
        key={quickChatAccountKey ?? "signed-out"}
        accountKey={quickChatAccountKey}
        isNextcloudConnected={isNextcloudConnected}
        onClose={() => setQuickChatOpen(false)}
        onOpenFullChat={() => {
          setQuickChatOpen(false);
          setActiveNav("talk");
        }}
      />
    ) : undefined;

  const globalBanners = (
    <>
      {availableUpdate &&
        availableUpdate.available &&
        !availableUpdate.skipped &&
        !updateBannerDismissed && (
          <UpdateBanner
            update={availableUpdate}
            onReviewUpdate={() => setUpdateDialogOpen(true)}
            onDismissLater={() => setUpdateBannerDismissed(true)}
            onSkipVersion={(ver) => void handleSkipUpdateVersion(ver)}
          />
        )}
      {overview.startupError && (
        <ErrorBanner error={overview.startupError} variant="strip" />
      )}
      {pendingMcpApprovals.length > 0 && activeModule?.id !== "mcp" && (
        <div
          role="alert"
          aria-label="MCP write approval request"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--text-primary)]"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert
              className="h-3.5 w-3.5 shrink-0 text-[var(--status-warning-text)]"
              strokeWidth={1.5}
            />
            <span>
              <strong>AI write request:</strong>{" "}
              <code className="mono-num">
                {pendingMcpApprovals[0].toolName}
              </code>{" "}
              — {pendingMcpApprovals[0].summary}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <InlineDeleteConfirm
              armed={armedApprovalId === pendingMcpApprovals[0].id}
              onArm={() => setArmedApprovalId(pendingMcpApprovals[0].id)}
              onCancel={() => setArmedApprovalId(null)}
              onConfirm={() => {
                const targetId = pendingMcpApprovals[0].id;
                setArmedApprovalId(null);
                void resolveMcpApproval(targetId, true).then(
                  refreshPendingApprovals,
                );
              }}
              label={`Allow AI write request ${pendingMcpApprovals[0].toolName}`}
              triggerLabel="Allow"
              confirmLabel="Allow write"
              tone="positive"
              compact
              triggerIcon={<Check className="h-3 w-3" strokeWidth={1.5} />}
            />
            <button
              type="button"
              onClick={() => {
                setArmedApprovalId(null);
                void resolveMcpApproval(
                  pendingMcpApprovals[0].id,
                  false,
                ).then(refreshPendingApprovals);
              }}
              className="inline-flex h-6 items-center gap-1 rounded border border-[var(--status-danger)] px-2 text-[11px] font-medium text-[var(--status-danger-text)] hover:bg-[var(--status-danger-soft)]"
            >
              <X className="h-3 w-3" strokeWidth={1.5} />
              Deny
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <a
        href="#fr-main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("fr-main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-md focus:border focus:border-[var(--border-strong)] focus:bg-[var(--bg-elevated)] focus:px-3 focus:py-1.5 focus:text-xs focus:font-medium focus:text-[var(--text-primary)]"
      >
        Skip to main content
      </a>
      {/* Far-Left 48px Fixed Module Rail */}
      <ModuleRail
        modules={overview.modules}
        activeId={activeNav}
        connectionStatus={overview.connectionStatus}
        mcpEnabled={overview.mcpServer.enabled}
        pendingMcpApprovals={pendingMcpApprovals.length}
        quickChatOpen={quickChatOpen}
        onSelect={(id) => {
          setError(null);
          setActiveNav(id);
          if (id === "talk") setQuickChatOpen(false);
        }}
        onToggleQuickChat={() => setQuickChatOpen((prev) => !prev)}
      />

      {/* Active Unified Module Shell */}
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
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          quickChatInspector={quickChatDrawerNode}
          onToggleInspector={handleToggleInspector}
          banners={globalBanners}
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
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          inspectorOpen={inspectorOpen}
          onToggleInspector={handleToggleInspector}
          onSetInspectorOpen={(open) => {
            if (open) setQuickChatOpen(false);
            setInspectorOpen(open);
          }}
          quickChatInspector={quickChatDrawerNode}
          banners={globalBanners}
        />
      ) : activeModule?.id === "finance" ? (
        <FinanceView
          financeFolder={overview.config.financeFolder}
          isNextcloudConnected={isNextcloudConnected}
          onOverviewUpdated={setOverview}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          inspectorOpen={inspectorOpen}
          onToggleInspector={handleToggleInspector}
          onSetInspectorOpen={(open) => {
            if (open) setQuickChatOpen(false);
            setInspectorOpen(open);
          }}
          quickChatInspector={quickChatDrawerNode}
          banners={globalBanners}
        />
      ) : activeModule?.id === "slicer" ? (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center gap-2 bg-[var(--bg-surface)] text-xs text-[var(--text-muted)]">
              <h1 className="sr-only">3D Printing</h1>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Loading 3D Slicer…
            </div>
          }
        >
          <SlicerView
            isNextcloudConnected={isNextcloudConnected}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((p) => !p)}
            onSetSidebarOpen={setSidebarOpen}
            inspectorOpen={inspectorOpen}
            onToggleInspector={handleToggleInspector}
            onSetInspectorOpen={(open) => {
              if (open) setQuickChatOpen(false);
              setInspectorOpen(open);
            }}
            quickChatOpen={quickChatOpen}
            onSetQuickChatOpen={setQuickChatOpen}
            quickChatInspector={quickChatDrawerNode}
            banners={globalBanners}
          />
        </Suspense>
      ) : activeModule?.id === "talk" ? (
        <TalkView
          isNextcloudConnected={isNextcloudConnected}
          currentActorId={
            overview.accountInfo?.id ??
            (overview.connectionStatus.state === "connected"
              ? overview.connectionStatus.loginName
              : null)
          }
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          inspectorOpen={inspectorOpen}
          onToggleInspector={handleToggleInspector}
          onSetInspectorOpen={setInspectorOpen}
          banners={globalBanners}
        />
      ) : activeModule?.id === "mcp" ? (
        <McpView
          isNextcloudConnected={isNextcloudConnected}
          pendingApprovals={pendingMcpApprovals}
          onRefreshApprovals={refreshPendingApprovals}
          onOverviewUpdated={setOverview}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          quickChatInspector={quickChatDrawerNode}
          onToggleInspector={handleToggleInspector}
          banners={globalBanners}
        />
      ) : activeModule?.id === "automation" ? (
        <AutomationsView
          isNextcloudConnected={isNextcloudConnected}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          quickChatInspector={quickChatDrawerNode}
          onToggleInspector={handleToggleInspector}
          banners={globalBanners}
        />
      ) : activeModule ? (
        <ModuleComingSoonView
          module={activeModule}
          banners={globalBanners}
        />
      ) : null}

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
