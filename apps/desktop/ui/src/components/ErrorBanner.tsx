import { AlertCircle, ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import type { UserFacingError } from "../bindings/tauri";
import { IconButton } from "./ui/Tooltip";

interface ErrorBannerProps {
  error: UserFacingError;
  onDismiss?: () => void;
  variant?: "card" | "strip";
}

export function ErrorBanner({
  error,
  onDismiss,
  variant = "card",
}: ErrorBannerProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      role="alert"
      className={
        variant === "strip"
          ? "border-b border-[var(--status-danger)]/35 bg-[var(--status-danger-soft)] px-4 py-2 text-xs text-[var(--text-primary)]"
          : "rounded-md border border-[var(--status-danger)]/35 bg-[var(--status-danger-soft)] px-3 py-2.5 text-xs text-[var(--text-primary)]"
      }
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-danger-text)]"
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--text-primary)]">{error.title}</p>
          <p className="mt-0.5 text-[var(--text-secondary)]">{error.message}</p>
          {error.recoveryHint && (
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {error.recoveryHint}
            </p>
          )}
          {error.technicalDetails && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setShowDetails((prev) => !prev)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {showDetails ? (
                  <>
                    <ChevronUp className="h-3 w-3" strokeWidth={1.5} />
                    Hide details
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" strokeWidth={1.5} />
                    Technical details
                  </>
                )}
              </button>
              {showDetails && (
                <pre className="mono-num mt-1.5 overflow-x-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-app)] p-2 text-[11px] text-[var(--text-secondary)]">
                  [{error.code}] {error.technicalDetails}
                </pre>
              )}
            </div>
          )}
        </div>
        {onDismiss && (
          <IconButton size="xs" label="Dismiss error" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
