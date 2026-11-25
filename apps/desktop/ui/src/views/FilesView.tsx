import {
  Box,
  CheckCircle2,
  Cloud,
  ExternalLink,
  FileCode2,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Loader2,
  LogIn,
  Settings,
  X,
} from "lucide-react";
import type {
  NextcloudConnectionStatus,
  UserAccountInfo_Serialize,
  UserFacingError,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatBytes, openExternalUrl } from "../lib/workspaceClient";

interface FilesViewProps {
  connectionStatus: NextcloudConnectionStatus;
  accountInfo: UserAccountInfo_Serialize | null;
  loginPendingUrl: string | null;
  loginStarting: boolean;
  error: UserFacingError | null;
  onClearError: () => void;
  onStartLogin: () => Promise<void>;
  onCancelLogin: () => Promise<void>;
  onOpenSettings: () => void;
}

const SUPPORTED_FORMATS = [
  {
    icon: FileText,
    label: "Markdown Notes",
    detail: "WYSIWYG editor + raw mode with conflict protection (.md)",
  },
  {
    icon: ImageIcon,
    label: "Images & PDFs",
    detail: "Zoom, pan, and document search (.png, .jpg, .webp, .pdf)",
  },
  {
    icon: Film,
    label: "Video Streaming",
    detail: "Instant playback via local Range proxy (.mp4, .mov, .webm)",
  },
  {
    icon: Layers,
    label: "Vector Files",
    detail: "Sanitized SVG, Illustrator AI, DXF CAD & EPS",
  },
  {
    icon: Box,
    label: "SolidWorks CAD",
    detail: "Client-side thumbnails & metadata (.sldprt, .sldasm, .slddrw)",
  },
  {
    icon: FileCode2,
    label: "Native Open",
    detail: "Launch any file directly in its desktop app with one click",
  },
];

export function FilesView({
  connectionStatus,
  accountInfo,
  loginPendingUrl,
  loginStarting,
  error,
  onClearError,
  onStartLogin,
  onCancelLogin,
  onOpenSettings,
}: FilesViewProps) {
  const configuredServer =
    connectionStatus.state === "notConfigured"
      ? null
      : connectionStatus.serverUrl;

  const quotaPct =
    accountInfo?.quotaTotalBytes && accountInfo.quotaTotalBytes > 0
      ? Math.min(
          100,
          Math.round(
            ((accountInfo.quotaUsedBytes ?? 0) / accountInfo.quotaTotalBytes) *
              100,
          ),
        )
      : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {error && <ErrorBanner error={error} onDismiss={onClearError} />}

      {connectionStatus.state === "connected" ? (
        <section className="rounded-2xl border border-emerald-200 bg-white p-6 shadow-xs dark:border-emerald-900/60 dark:bg-slate-900">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Connected as{" "}
                  {accountInfo?.displayName || connectionStatus.loginName}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Signed in securely to{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-200">
                    {connectionStatus.serverUrl}
                  </span>{" "}
                  with your OS Keychain.
                </p>
                {accountInfo && (
                  <div className="mt-3 max-w-xs space-y-1">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Storage used: {formatBytes(accountInfo.quotaUsedBytes)}
                      {accountInfo.quotaTotalBytes
                        ? ` of ${formatBytes(accountInfo.quotaTotalBytes)}`
                        : ""}
                    </p>
                    {quotaPct !== null && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all"
                          style={{ width: `${quotaPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Settings className="h-4 w-4" />
              Account Settings
            </button>
          </div>
        </section>
      ) : loginPendingUrl ? (
        <section className="rounded-2xl border border-blue-200 bg-white p-6 shadow-xs dark:border-blue-900/60 dark:bg-slate-900">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Finish signing in via your browser
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  We opened Nextcloud in your browser. Click{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-200">
                    Log in
                  </span>{" "}
                  and{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-200">
                    Grant access
                  </span>{" "}
                  — this window will connect automatically.
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void openExternalUrl(loginPendingUrl)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open browser again
              </button>
              <button
                type="button"
                onClick={() => void onCancelLogin()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3.5 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
                <Cloud className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Connect your Nextcloud workspace
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {configuredServer ? (
                    <>
                      Sign in with one click to{" "}
                      <span className="font-medium text-slate-900 dark:text-slate-200">
                        {configuredServer}
                      </span>
                      . Supports 2FA and SSO automatically.
                    </>
                  ) : (
                    "Enter your team's Nextcloud server address in Settings to get started."
                  )}
                </p>
                {configuredServer && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="mt-2 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    Change server…
                  </button>
                )}
              </div>
            </div>

            {configuredServer ? (
              <button
                type="button"
                disabled={loginStarting}
                onClick={() => void onStartLogin()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {loginStarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {loginStarting ? "Opening browser..." : "Sign in with Nextcloud"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700"
              >
                <Settings className="h-4 w-4" />
                Configure Server
              </button>
            )}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
          Built for your team&apos;s files
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUPPORTED_FORMATS.map(({ icon: Icon, label, detail }) => (
            <div
              key={label}
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {label}
                </p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {detail}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
