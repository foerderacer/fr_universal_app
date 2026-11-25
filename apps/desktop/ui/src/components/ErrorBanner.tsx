import { AlertCircle, ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import type { UserFacingError } from "../bindings/tauri";

interface ErrorBannerProps {
  error: UserFacingError;
  onDismiss?: () => void;
}

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{error.title}</p>
          <p className="mt-1 text-sm text-rose-800 dark:text-rose-200">
            {error.message}
          </p>
          {error.recoveryHint && (
            <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
              {error.recoveryHint}
            </p>
          )}
          {error.technicalDetails && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowDetails((prev) => !prev)}
                className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                {showDetails ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" />
                    Hide technical details
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" />
                    Show technical details
                  </>
                )}
              </button>
              {showDetails && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-rose-100/80 p-2.5 font-mono text-xs text-rose-900 dark:bg-rose-950/80 dark:text-rose-200">
                  [{error.code}] {error.technicalDetails}
                </pre>
              )}
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss message"
            className="rounded-lg p-1 text-rose-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/50 dark:hover:text-rose-200"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
