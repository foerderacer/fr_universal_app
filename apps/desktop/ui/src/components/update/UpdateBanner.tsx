import { Download, Sparkles, X } from "lucide-react";
import type { AppUpdateCheckResult_Serialize } from "../../bindings/tauri";

interface UpdateBannerProps {
  update: AppUpdateCheckResult_Serialize;
  onReviewUpdate: () => void;
  onDismissLater: () => void;
  onSkipVersion: (version: string) => void;
}

export function UpdateBanner({
  update,
  onReviewUpdate,
  onDismissLater,
  onSkipVersion,
}: UpdateBannerProps) {
  const latest = update.latestVersion ?? "new";
  return (
    <div
      role="status"
      className="mx-auto mb-4 max-w-5xl rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 shadow-xs dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Sparkles className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="truncate">
            <strong>A new version (v{latest}) of FR Universal App is ready.</strong>{" "}
            Updates are cryptographically signed and verified before installing.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReviewUpdate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
          >
            <Download className="h-3.5 w-3.5" />
            Update now
          </button>
          <button
            type="button"
            onClick={onDismissLater}
            className="rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 font-medium text-blue-800 hover:bg-blue-100/60 dark:border-blue-800 dark:bg-slate-900 dark:text-blue-200"
          >
            Later
          </button>
          {update.latestVersion && (
            <button
              type="button"
              onClick={() => onSkipVersion(update.latestVersion!)}
              className="rounded-lg px-2 py-1.5 font-medium text-blue-700 hover:underline dark:text-blue-300"
            >
              Skip v{latest}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss update notification"
            onClick={onDismissLater}
            className="rounded-lg p-1 text-blue-600 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
