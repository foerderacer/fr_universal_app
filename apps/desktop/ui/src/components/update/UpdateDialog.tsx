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
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";
import { IconButton } from "../ui/Tooltip";

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
          "Couldn't verify unsaved drafts automatically. Make sure your work is saved.",
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
      if (!cancelled) setProgress(event.payload);
    })
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
    <Modal
      ariaLabel="Update FR Universal App"
      onClose={onClose}
      closeOnScrim={!installing}
      closeOnEscape={!installing}
    >
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]">
        <div className="flex h-11 items-center justify-between border-b border-[var(--border-hairline)] px-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-[var(--text-primary)]">
              Update FR Universal App
            </h2>
            <span className="mono-num text-[11px] text-[var(--text-muted)]">
              v{update.currentVersion} → v{latest}
            </span>
          </div>
          {!installing && (
            <IconButton size="xs" label="Close" onClick={onClose}>
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </IconButton>
          )}
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-4 text-xs">
          {error && (
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          )}

          {installFinishedManualRestart && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--status-positive)]/35 bg-[var(--status-positive-soft)] p-3 text-[var(--text-primary)]">
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-positive-text)]"
                strokeWidth={1.5}
              />
              <p>
                <strong>Update ready.</strong> Close and reopen FR Universal App
                if it does not relaunch automatically.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-medium text-[var(--text-secondary)]">
                Release Notes
              </h3>
              <button
                type="button"
                onClick={() => void openExternalUrl(update.releaseUrl)}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--accent-text)] hover:underline"
              >
                View on GitHub
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
              </button>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 whitespace-pre-wrap text-[var(--text-secondary)]">
              {update.notes?.trim()
                ? update.notes
                : "Performance, reliability, and security improvements."}
            </div>
          </div>

          {checkingSafety ? (
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              Checking unsaved drafts…
            </div>
          ) : needsOverride && safety ? (
            <div className="space-y-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] p-3 text-[var(--text-primary)]">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning-text)]"
                  strokeWidth={1.5}
                />
                <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
                  {safety.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span>Continue and restart anyway</span>
                <Switch
                  ariaLabel="Continue and restart anyway"
                  checked={confirmOverride}
                  disabled={installing}
                  onChange={setConfirmOverride}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11px] text-[var(--text-secondary)]">
              <ShieldCheck
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-positive-text)]"
                strokeWidth={1.5}
              />
              <span>
                Downloads the signed release, verifies its signature, and
                restarts automatically.
              </span>
            </div>
          )}

          {installing && (
            <div className="space-y-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
              <div className="mono-num flex items-center justify-between text-[11px]">
                <span>
                  {progress?.percent != null
                    ? `${progress.percent}%`
                    : "Downloading…"}
                </span>
                {progress && progress.downloadedBytes > 0 && (
                  <span className="text-[var(--text-muted)]">
                    {formatBytes(progress.downloadedBytes)}
                    {progress.totalBytes
                      ? ` / ${formatBytes(progress.totalBytes)}`
                      : ""}
                  </span>
                )}
              </div>
              <div
                role="progressbar"
                aria-label="Update download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress?.percent ?? 0)}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]"
              >
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-150"
                  style={{ width: `${Math.max(4, progress?.percent ?? 20)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3">
          {!installing &&
          !installFinishedManualRestart &&
          update.latestVersion ? (
            <button
              type="button"
              onClick={() => onSkipVersion(update.latestVersion!)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Skip v{latest}
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {!installing && (
              <button
                type="button"
                onClick={onClose}
                className="h-8 rounded-md border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                {installFinishedManualRestart ? "Close" : "Later"}
              </button>
            )}
            {!installFinishedManualRestart && (
              <button
                type="button"
                disabled={!canStartInstall}
                onClick={() => void handleInstall()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {installing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                {installing ? "Updating…" : "Download & Install"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
