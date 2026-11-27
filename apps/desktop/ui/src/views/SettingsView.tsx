import {
  Check,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AppUpdateCheckResult_Serialize,
  UpdateSettingsRequest,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { formatIsoDateTime } from "../lib/dateFormat";
import { QUICK_CHAT_SHORTCUT } from "../lib/platform";
import {
  areSingleKeyShortcutsEnabled,
  hasActiveOverlay,
  isEditableTarget,
  setSingleKeyShortcutsEnabled,
} from "../lib/shortcuts";
import {
  GITHUB_RELEASES_URL,
  checkForAppUpdate,
  clearSkippedAppUpdate,
  formatBytes,
  openExternalUrl,
  toUserFacingError,
} from "../lib/workspaceClient";

interface SettingsViewProps {
  overview: WorkspaceOverview_Serialize;
  onSave: (input: UpdateSettingsRequest) => Promise<void>;
  onResetUrl: () => Promise<string>;
  onSignOut: () => Promise<void>;
  onOverviewUpdated: (overview: WorkspaceOverview_Serialize) => void;
  onOpenUpdateDialog: (update: AppUpdateCheckResult_Serialize) => void;
  error: UserFacingError | null;
  onClearError: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  quickChatInspector?: React.ReactNode;
  onToggleInspector?: () => void;
  banners?: React.ReactNode;
}

type SettingsSection = "connection" | "appearance" | "mcp" | "updates";

export function SettingsView({
  overview,
  onSave,
  onResetUrl,
  onSignOut,
  onOverviewUpdated,
  onOpenUpdateDialog,
  error,
  onClearError,
  sidebarOpen,
  onToggleSidebar,
  quickChatInspector,
  onToggleInspector,
  banners,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("connection");
  const [nextcloudUrl, setNextcloudUrl] = useState(
    overview.config.nextcloudUrl,
  );
  const [cacheLimitInput, setCacheLimitInput] = useState(
    String(overview.config.cacheLimitMb),
  );
  const [theme, setTheme] = useState(overview.config.theme);
  const [mcpServerEnabled, setMcpServerEnabled] = useState(
    overview.config.mcpServerEnabled,
  );
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [signOutArmed, setSignOutArmed] = useState(false);
  const [resetUrlArmed, setResetUrlArmed] = useState(false);
  const [singleKeyShortcuts, setSingleKeyShortcuts] = useState(() =>
    areSingleKeyShortcutsEnabled(),
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] =
    useState<AppUpdateCheckResult_Serialize | null>(null);
  const [updateError, setUpdateError] = useState<UserFacingError | null>(null);

  useEffect(() => {
    setNextcloudUrl(overview.config.nextcloudUrl);
  }, [overview.config.nextcloudUrl]);

  useEffect(() => {
    setCacheLimitInput(String(overview.config.cacheLimitMb));
  }, [overview.config.cacheLimitMb]);

  useEffect(() => {
    setTheme(overview.config.theme);
  }, [overview.config.theme]);

  useEffect(() => {
    setMcpServerEnabled(overview.config.mcpServerEnabled);
  }, [overview.config.mcpServerEnabled]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSavedNotice(false);
    const parsedCacheLimit = Math.max(
      128,
      Math.min(32768, Math.round(Number(cacheLimitInput)) || 2048),
    );
    setCacheLimitInput(String(parsedCacheLimit));
    try {
      await onSave({
        nextcloudUrl,
        cacheLimitMb: parsedCacheLimit,
        mcpServerEnabled,
        theme,
      });
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2500);
    } catch {
      // Error displayed by parent.
    } finally {
      setSaving(false);
    }
  }

  async function handleResetUrl() {
    setSaving(true);
    setSavedNotice(false);
    try {
      const updatedUrl = await onResetUrl();
      setNextcloudUrl(updatedUrl);
    } catch {
      // Handled by parent.
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    setSaving(true);
    setSavedNotice(false);
    try {
      await onSignOut();
    } catch {
      // Handled by parent.
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckForUpdate() {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const res = await checkForAppUpdate();
      setUpdateResult(res);
      if (res.lastCheckedAt) {
        onOverviewUpdated({
          ...overview,
          config: {
            ...overview.config,
            lastUpdateCheckAt: res.lastCheckedAt,
          },
        });
      }
    } catch (err) {
      setUpdateError(toUserFacingError(err));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleResetSkippedVersion() {
    setUpdateError(null);
    try {
      const updated = await clearSkippedAppUpdate();
      onOverviewUpdated(updated);
      setUpdateResult(null);
    } catch (err) {
      setUpdateError(toUserFacingError(err));
    }
  }

  useEffect(() => {
    const ids: SettingsSection[] = [
      "connection",
      "appearance",
      "mcp",
      "updates",
    ];
    const elements = ids
      .map((id) => ({ id, el: document.getElementById(`settings-${id}`) }))
      .filter((x): x is { id: SettingsSection; el: HTMLElement } =>
        Boolean(x.el),
      );
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (visible.length > 0) {
          const matched = elements.find((x) => x.el === visible[0].target);
          if (matched) setActiveSection(matched.id);
        }
      },
      { rootMargin: "-10% 0px -65% 0px", threshold: 0 },
    );
    for (const { el } of elements) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const jumpTo = (id: SettingsSection) => {
      setActiveSection(id);
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      document.getElementById(`settings-${id}`)?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!areSingleKeyShortcutsEnabled()) return;
      if (hasActiveOverlay() || isEditableTarget(e.target)) return;
      if (e.key === "1") {
        e.preventDefault();
        jumpTo("connection");
      } else if (e.key === "2") {
        e.preventDefault();
        jumpTo("appearance");
      } else if (e.key === "3") {
        e.preventDefault();
        jumpTo("mcp");
      } else if (e.key === "4") {
        e.preventDefault();
        jumpTo("updates");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const sidebarNode = (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
          Preferences
        </h2>
        <nav aria-label="Preferences" className="space-y-0.5">
        {(
          [
            { id: "connection", label: "Nextcloud", icon: Cloud },
            { id: "appearance", label: "Appearance & Cache", icon: Palette },
            { id: "mcp", label: "Local MCP", icon: Cpu },
            { id: "updates", label: "About & Updates", icon: Info },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={activeSection === id ? "page" : undefined}
            onClick={() => {
              setActiveSection(id);
              const reduceMotion = window.matchMedia(
                "(prefers-reduced-motion: reduce)",
              ).matches;
              document.getElementById(`settings-${id}`)?.scrollIntoView({
                behavior: reduceMotion ? "auto" : "smooth",
                block: "start",
              });
            }}
            className={`relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              activeSection === id
                ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            {activeSection === id && (
              <span
                aria-hidden="true"
                className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
              />
            )}
            <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
        </nav>
      </div>
      <div className="mono-num flex h-8 shrink-0 items-center border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        v{overview.appVersion} · {overview.platform}
      </div>
    </div>
  );

  return (
    <WorkspaceLayout
      moduleId="settings"
      headerLeft={
        <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
          Settings
        </h1>
      }
      headerRight={
        <div className="flex items-center gap-2">
          {savedNotice && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--status-positive-text)]"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
              Saved
            </span>
          )}
          <button
            type="submit"
            form="settings-form"
            disabled={saving}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.5} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      }
      sidebar={sidebarNode}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      inspector={quickChatInspector}
      inspectorOpen={Boolean(quickChatInspector)}
      onToggleInspector={onToggleInspector}
      inspectorLabel={quickChatInspector ? "Quick chat" : "Details inspector"}
      inspectorToggleLabel={quickChatInspector ? "Close quick chat" : undefined}
      inspectorToggleShortcut={quickChatInspector ? QUICK_CHAT_SHORTCUT : undefined}
      canvasMode="document"
      banners={banners}
    >
      <form
        id="settings-form"
        onSubmit={handleSubmit}
        className="space-y-5"
      >
          {error && <ErrorBanner error={error} onDismiss={onClearError} />}

          {overview.connectionStatus.state === "connected" && (
            <section className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-positive)]" />
                    <h2 className="text-xs font-medium text-[var(--text-primary)]">
                      Connected Account
                    </h2>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    {overview.accountInfo?.displayName ||
                      overview.connectionStatus.loginName}{" "}
                    <span className="mono-num text-[var(--text-muted)]">
                      ({overview.connectionStatus.loginName})
                    </span>
                  </p>
                  {overview.accountInfo && (
                    <p className="mono-num mt-0.5 text-[11px] text-[var(--text-muted)]">
                      Quota: {formatBytes(overview.accountInfo.quotaUsedBytes)}
                      {overview.accountInfo.quotaTotalBytes
                        ? ` / ${formatBytes(overview.accountInfo.quotaTotalBytes)}`
                        : ""}
                    </p>
                  )}
                </div>

                <InlineDeleteConfirm
                  armed={signOutArmed}
                  onArm={() => setSignOutArmed(true)}
                  onCancel={() => setSignOutArmed(false)}
                  onConfirm={() => {
                    setSignOutArmed(false);
                    void handleSignOut();
                  }}
                  label="Sign out of Nextcloud"
                  triggerLabel="Sign out"
                  confirmLabel="Sign out"
                  triggerIcon={<LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />}
                  disabled={saving}
                />
              </div>
            </section>
          )}

          <section
            id="settings-connection"
            className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4"
          >
            <h2 className="text-xs font-medium text-[var(--text-primary)]">
              Nextcloud Server
            </h2>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Credentials are stored exclusively in your operating system
              Keychain.
            </p>
            <div className="mt-3 space-y-1.5">
              <label
                htmlFor="nextcloud-url"
                className="block text-[11px] text-[var(--text-secondary)]"
              >
                Server URL
              </label>
              <div className="flex gap-2">
                <input
                  id="nextcloud-url"
                  type="text"
                  value={nextcloudUrl}
                  onChange={(e) => setNextcloudUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://cloud.example.com"
                  className="mono-num h-8 block w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
                />
                {overview.defaultNextcloudUrl && (
                  <InlineDeleteConfirm
                    armed={resetUrlArmed}
                    onArm={() => setResetUrlArmed(true)}
                    onCancel={() => setResetUrlArmed(false)}
                    onConfirm={() => {
                      setResetUrlArmed(false);
                      void handleResetUrl();
                    }}
                    disabled={saving}
                    label="Reset Nextcloud server URL to default"
                    triggerLabel="Reset"
                    confirmLabel="Reset URL"
                    tone="neutral"
                    triggerIcon={
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
                    }
                  />
                )}
              </div>
              {nextcloudUrl.trim().toLowerCase().startsWith("http://") && (
                <p className="text-[11px] text-[var(--status-warning-text)]">
                  Uses unencrypted <code className="mono-num">http://</code>.
                  Prefer <code className="mono-num">https://</code> in
                  production.
                </p>
              )}
            </div>
          </section>

          <section
            id="settings-appearance"
            className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4"
          >
            <h2 className="text-xs font-medium text-[var(--text-primary)]">
              Appearance &amp; Local Cache
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="theme-select"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Theme
                </label>
                <Select
                  id="theme-select"
                  ariaLabel="Theme"
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { value: "dark", label: "Dark (Default)" },
                    { value: "system", label: "Match system" },
                    { value: "light", label: "Light" },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="cache-limit"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Max local cache (MB)
                </label>
                <input
                  id="cache-limit"
                  type="number"
                  min={128}
                  max={32768}
                  step={128}
                  value={cacheLimitInput}
                  onChange={(e) => setCacheLimitInput(e.target.value)}
                  onBlur={() => {
                    const parsed = Number(cacheLimitInput);
                    if (!Number.isFinite(parsed) || parsed < 128) {
                      setCacheLimitInput(String(overview.config.cacheLimitMb));
                    } else if (parsed > 32768) {
                      setCacheLimitInput("32768");
                    } else {
                      setCacheLimitInput(String(Math.round(parsed)));
                    }
                  }}
                  className="mono-num h-8 block w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3">
              <div>
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  Single-key shortcuts
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                  Allow single-key shortcuts like /, F, [, and ] when not typing
                  in a text field.
                </p>
              </div>
              <Switch
                checked={singleKeyShortcuts}
                onChange={(next) => {
                  setSingleKeyShortcuts(next);
                  setSingleKeyShortcutsEnabled(next);
                }}
                ariaLabel="Enable single-key keyboard shortcuts"
              />
            </div>
          </section>

          <section
            id="settings-mcp"
            className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xs font-medium text-[var(--text-primary)]">
                  Local MCP Server
                </h2>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Runs on this computer only with an access key stored in your
                  system keychain.
                </p>
                <p className="mono-num mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  <ShieldCheck
                    className="h-3.5 w-3.5 text-[var(--status-positive-text)]"
                    strokeWidth={1.5}
                  />
                  {overview.mcpServer.bindHost}:{overview.mcpServer.port}
                </p>
              </div>
              <Switch
                checked={mcpServerEnabled}
                onChange={setMcpServerEnabled}
                ariaLabel="Enable Local MCP Server"
              />
            </div>
          </section>

          <section
            id="settings-updates"
            className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xs font-medium text-[var(--text-primary)]">
                  About &amp; Updates
                </h2>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Version{" "}
                  <span className="mono-num text-[var(--text-primary)]">
                    v{overview.appVersion}
                  </span>{" "}
                  ({overview.platform}). Signed updates verify before
                  installing.
                </p>
                {overview.config.lastUpdateCheckAt && (
                  <p className="mono-num mt-1 text-[11px] text-[var(--text-muted)]">
                    Last checked:{" "}
                    {formatIsoDateTime(overview.config.lastUpdateCheckAt)}
                  </p>
                )}
                {overview.config.skippedUpdateVersion && (
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--status-warning-text)]">
                    <span className="mono-num">
                      Skipped v{overview.config.skippedUpdateVersion}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleResetSkippedVersion()}
                      className="underline"
                    >
                      Reset
                    </button>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void openExternalUrl(GITHUB_RELEASES_URL)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Releases
                </button>
                <button
                  type="button"
                  disabled={checkingUpdate}
                  onClick={() => void handleCheckForUpdate()}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                >
                  {checkingUpdate ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                  Check Updates
                </button>
              </div>
            </div>

            {updateError && (
              <div className="mt-3">
                <ErrorBanner
                  error={updateError}
                  onDismiss={() => setUpdateError(null)}
                />
              </div>
            )}

            {updateResult && (
              <div className="mt-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-xs">
                <p className="text-[var(--text-primary)]">
                  {updateResult.message}
                </p>
                {updateResult.notes && (
                  <p className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--text-secondary)]">
                    {updateResult.notes}
                  </p>
                )}
                {updateResult.available && (
                  <button
                    type="button"
                    onClick={() => onOpenUpdateDialog(updateResult)}
                    className="mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                  >
                    <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Install v{updateResult.latestVersion}
                  </button>
                )}
              </div>
            )}
          </section>
        </form>
    </WorkspaceLayout>
  );
}
