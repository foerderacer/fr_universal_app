import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AppUpdateCheckResult_Serialize,
  UpdateSafetyStatus,
  UserFacingError,
} from "../../bindings/tauri";
import {
  formatBytes,
  getUpdateSafetyStatus,
  installAppUpdate,
  openExternalUrl,
  toUserFacingError,
} from "../../lib/workspaceClient";
import { ErrorBanner } from "../ErrorBanner";

interface UpdateProgressEvent {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

interface UpdateDialogProps {
  update: AppUpdateCheckResult_Serialize;
  onClose: () => void;
  onSkipVersion: (version: string) => void;
}

export function UpdateDialog({
  update,
  onClose,
  onSkipVersion,
}: UpdateDialogProps) {
  const [safety, setSafety] = useState<UpdateSafetyStatus | null>(null);
  const [checkingSafety, setCheckingSafety] = useState(true);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installFinishedManualRestart, setInstallFinishedManualRestart] =
    useState(false);
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);

  const refreshSafety = useCallback(async () => {
    setCheckingSafety(true);
    try {
      const res = await getUpdateSafetyStatus();
      setSafety(res);
    } catch {
      setSafety({
        safeToRestart: false,
        pendingDraftsCount: 0,
        runningWorkflowsCount: 0,
        warnings: [
          "Couldn't verify unsaved drafts automatically. Please make sure your work is saved before installing.",
        ],
      });
    } finally {
      setCheckingSafety(false);
    }
  }, []);

  useEffect(() => {
    void refreshSafety();
  }, [refreshSafety]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdateProgressEvent>("app://update-progress", (event) => {
      if (!cancelled) {
        setProgress(event.payload);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !installing) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [installing, onClose]);

  const latest = update.latestVersion ?? "latest";
  const needsOverride = Boolean(safety && !safety.safeToRestart);
  const canStartInstall =
    !checkingSafety &&
    !installing &&
    !installFinishedManualRestart &&
    (!needsOverride || confirmOverride);

  async function handleInstall() {
    setError(null);
    setInstalling(true);
    setProgress({ downloadedBytes: 0, totalBytes: null, percent: null });
    try {
      await installAppUpdate(needsOverride && confirmOverride);
      // If the platform does not exit/relaunch automatically (or no newer update was pending),
      // never leave the modal stuck in an un-closable spinner state.
      setInstalling(false);
      setInstallFinishedManualRestart(true);
    } catch (err) {
      const parsed = toUserFacingError(err);
      setError(parsed);
      setInstalling(false);
      if (parsed.code === "update_unsafe_to_restart") {
        setConfirmOverride(false);
        await refreshSafety();
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2
              id="update-dialog-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Update FR Universal App
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              v{update.currentVersion} → <strong>v{latest}</strong>
            </p>
          </div>
          {!installing && (
            <button
              type="button"
              aria-label="Close update dialog"
              onClick={onClose}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {error && (
            <div className="space-y-2">
              <ErrorBanner error={error} onDismiss={() => setError(null)} />
              <button
                type="button"
                onClick={() => void openExternalUrl(update.releaseUrl)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Download the latest installer from GitHub Releases
              </button>
            </div>
          )}

          {installFinishedManualRestart && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p>
                <strong>Update ready.</strong> Close and reopen FR Universal App
                if it does not relaunch automatically.
              </p>
            </div>
          )}

          {/* Release Notes */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 dark:text-slate-200">
                What&apos;s new in v{latest}
              </h3>
              <button
                type="button"
                onClick={() => void openExternalUrl(update.releaseUrl)}
                className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                See all changes
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
              {update.notes?.trim()
                ? update.notes
                : "Performance, reliability, and security improvements."}
            </div>
          </div>

          {/* Pre-restart Safety Gate (runs BEFORE download & install for Windows safety) */}
          {checkingSafety ? (
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking for unsaved drafts or running workflows...
            </div>
          ) : needsOverride && safety ? (
            <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <p className="font-semibold">
                    Please save your work before installing
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {safety.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-2 pt-1 font-medium">
                <input
                  type="checkbox"
                  checked={confirmOverride}
                  disabled={installing}
                  onChange={(e) => setConfirmOverride(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-amber-400"
                />
                I understand — continue and restart FR Universal App to install
              </label>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p>
                FR Universal App will download the signed update, verify its
                signature, and restart to finish installing.
              </p>
            </div>
          )}

          {/* Download Progress */}
          {installing && (
            <div className="space-y-1.5 rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 dark:border-blue-900/60 dark:bg-blue-950/30">
              <div className="flex items-center justify-between font-medium text-blue-900 dark:text-blue-200">
                <span>
                  {progress?.percent !== null && progress?.percent !== undefined
                    ? progress.percent >= 100
                      ? "Installing signed update..."
                      : `Downloading update… ${progress.percent}%`
                    : "Downloading update…"}
                </span>
                {progress && progress.downloadedBytes > 0 && (
                  <span className="font-mono text-[11px]">
                    {formatBytes(progress.downloadedBytes)}
                    {progress.totalBytes
                      ? ` / ${formatBytes(progress.totalBytes)}`
                      : ""}
                  </span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-blue-200/80 dark:bg-blue-900/60">
                {progress?.percent !== null &&
                progress?.percent !== undefined ? (
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-150"
                    style={{ width: `${Math.max(2, progress.percent)}%` }}
                  />
                ) : (
                  <div className="h-full w-full animate-pulse rounded-full bg-blue-500/70" />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-slate-800">
          {!installing &&
          !installFinishedManualRestart &&
          update.latestVersion ? (
            <button
              type="button"
              onClick={() => onSkipVersion(update.latestVersion!)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
            >
              Skip version {latest}
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {!installing && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {installFinishedManualRestart ? "Close" : "Later"}
              </button>
            )}
            {!installFinishedManualRestart && (
              <button
                type="button"
                disabled={!canStartInstall}
                onClick={() => void handleInstall()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {installing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {installing ? "Updating..." : "Download & Install"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
