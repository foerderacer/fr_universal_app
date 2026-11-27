import { Download, X } from "lucide-react";
import type { AppUpdateCheckResult_Serialize } from "../../bindings/tauri";
import { IconButton } from "../ui/Tooltip";

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
      className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--accent-border)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--text-primary)]"
    >
      <span className="truncate">
        Update{" "}
        <span className="mono-num font-medium">v{latest}</span> is available
        (signed release).
      </span>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onReviewUpdate}
          className="inline-flex h-6 items-center gap-1 rounded bg-[var(--accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)]"
        >
          <Download className="h-3 w-3" strokeWidth={1.5} />
          Update
        </button>
        {update.latestVersion && (
          <button
            type="button"
            onClick={() => onSkipVersion(update.latestVersion!)}
            className="h-6 rounded px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Skip
          </button>
        )}
        <IconButton size="xs" label="Dismiss" onClick={onDismissLater}>
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  );
}
