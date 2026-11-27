import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { IconButton } from "../ui/Tooltip";

export interface NoticeBannerProps {
  message: string;
  tone?: "positive" | "warning" | "info";
  onDismiss: () => void;
  actions?: React.ReactNode;
}

export function NoticeBanner({
  message,
  tone = "positive",
  onDismiss,
  actions,
}: NoticeBannerProps) {
  const toneClass =
    tone === "warning"
      ? "border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)]"
      : tone === "info"
        ? "border-[var(--accent-border)] bg-[var(--accent-soft)]"
        : "border-[var(--status-positive)]/30 bg-[var(--status-positive-soft)]";

  return (
    <div
      role="status"
      className={`flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs text-[var(--text-primary)] ${toneClass}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {tone === "warning" ? (
          <AlertTriangle
            className="h-3.5 w-3.5 shrink-0 text-[var(--status-warning-text)]"
            strokeWidth={1.5}
          />
        ) : tone === "info" ? (
          <Info
            className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]"
            strokeWidth={1.5}
          />
        ) : (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-[var(--status-positive-text)]"
            strokeWidth={1.5}
          />
        )}
        <span className="truncate">{message}</span>
      </span>

      <div className="flex shrink-0 items-center gap-1.5">
        {actions}
        <IconButton size="xs" label="Dismiss" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  );
}
