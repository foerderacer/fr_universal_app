import { Check, LogOut, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  UpdateSettingsRequest,
  UserFacingError,
  WorkspaceOverview_Serialize,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatBytes } from "../lib/workspaceClient";

interface SettingsViewProps {
  overview: WorkspaceOverview_Serialize;
  onSave: (input: UpdateSettingsRequest) => Promise<void>;
  onResetUrl: () => Promise<string>;
  onSignOut: () => Promise<void>;
  error: UserFacingError | null;
  onClearError: () => void;
}

export function SettingsView({
  overview,
  onSave,
  onResetUrl,
  onSignOut,
  error,
  onClearError,
}: SettingsViewProps) {
  const [nextcloudUrl, setNextcloudUrl] = useState(
    overview.config.nextcloudUrl,
  );
  const [cacheLimitMb, setCacheLimitMb] = useState(
    overview.config.cacheLimitMb,
  );
  const [theme, setTheme] = useState(overview.config.theme);
  const [mcpServerEnabled, setMcpServerEnabled] = useState(
    overview.config.mcpServerEnabled,
  );
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setNextcloudUrl(overview.config.nextcloudUrl);
  }, [overview.config.nextcloudUrl]);

  useEffect(() => {
    setCacheLimitMb(overview.config.cacheLimitMb);
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
    try {
      await onSave({
        nextcloudUrl,
        cacheLimitMb,
        mcpServerEnabled,
        theme,
      });
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2500);
    } catch {
      // Error banner is displayed by parent.
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
      // Error banner is displayed by parent; keep the user's current draft intact.
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
      // Error banner is displayed by parent.
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-2xl space-y-6">
      {error && <ErrorBanner error={error} onDismiss={onClearError} />}

      {overview.connectionStatus.state === "connected" && (
        <section className="rounded-2xl border border-emerald-200 bg-white p-6 shadow-xs dark:border-emerald-900/60 dark:bg-slate-900">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Connected Account
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Signed in as{" "}
                <span className="font-medium text-slate-900 dark:text-slate-200">
                  {overview.accountInfo?.displayName ||
                    overview.connectionStatus.loginName}
                </span>{" "}
                ({overview.connectionStatus.loginName})
              </p>
              {overview.accountInfo && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Quota: {formatBytes(overview.accountInfo.quotaUsedBytes)}
                  {overview.accountInfo.quotaTotalBytes
                    ? ` / ${formatBytes(overview.accountInfo.quotaTotalBytes)}`
                    : ""}
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSignOut()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-200 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out &amp; clear cache
            </button>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Nextcloud Server
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Your team&apos;s Nextcloud web address. Credentials are always stored
          in your operating system&apos;s Keychain, never in plain files.
        </p>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="nextcloud-url"
            className="block text-xs font-medium text-slate-700 dark:text-slate-300"
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
              className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            {overview.defaultNextcloudUrl && (
              <button
                type="button"
                onClick={() => void handleResetUrl()}
                disabled={saving}
                title="Reset to build default server URL"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Default
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Appearance &amp; Local Cache
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label
              htmlFor="theme-select"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Theme
            </label>
            <select
              id="theme-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="cache-limit"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Max local cache (MB)
            </label>
            <input
              id="cache-limit"
              type="number"
              min={128}
              max={32768}
              step={128}
              value={cacheLimitMb}
              onChange={(e) => setCacheLimitMb(Number(e.target.value) || 2048)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Local MCP Server (AI Integrations)
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Allows approved local AI assistants to work with your workspace
              modules. Disabled by default and locked to this device only.
            </p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              Loopback only: {overview.mcpServer.bindHost}:
              {overview.mcpServer.port}
            </p>
          </div>

          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={mcpServerEnabled}
              onChange={(e) => setMcpServerEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-slate-200 transition-colors peer-checked:bg-blue-600 peer-focus:ring-2 peer-focus:ring-blue-500/30 dark:bg-slate-700" />
            <div className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-xs transition-transform peer-checked:translate-x-5" />
          </label>
        </div>
      </section>

      <div className="flex items-center justify-end gap-3">
        {savedNotice && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" />
            Settings saved
          </span>
        )}
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </form>
  );
}
