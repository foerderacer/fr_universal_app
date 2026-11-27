import { Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { IconButton } from "./Tooltip";

interface InlineDeleteConfirmProps {
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  label: string;
  confirmLabel?: string;
  triggerLabel?: string;
  triggerIcon?: React.ReactNode;
  tone?: "danger" | "positive" | "neutral";
  compact?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  iconClassName?: string;
}

/**
 * Canonical two-step inline confirmation used across all modules for destructive
 * or disruptive actions (deletions, resets, log clears, AI write approvals).
 * Preserves keyboard focus cleanly: moves focus to Cancel when armed, handles
 * Escape dismissal, and restores focus to the trigger button on cancel.
 */
export function InlineDeleteConfirm({
  armed,
  onArm,
  onCancel,
  onConfirm,
  label,
  confirmLabel = "Delete",
  triggerLabel,
  triggerIcon,
  tone = "danger",
  compact = false,
  disabled = false,
  tabIndex,
  iconClassName = "h-3.5 w-3.5",
}: InlineDeleteConfirmProps) {
  const triggerWrapRef = useRef<HTMLSpanElement | null>(null);
  const groupRef = useRef<HTMLSpanElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const wasArmedRef = useRef(false);
  const restoreFocusOnDisarmRef = useRef(true);

  useEffect(() => {
    if (armed) {
      wasArmedRef.current = true;
      restoreFocusOnDisarmRef.current = true;
      cancelBtnRef.current?.focus();
    } else if (wasArmedRef.current) {
      wasArmedRef.current = false;
      if (restoreFocusOnDisarmRef.current) {
        triggerWrapRef.current?.querySelector("button")?.focus();
      }
      restoreFocusOnDisarmRef.current = true;
    }
  }, [armed]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        restoreFocusOnDisarmRef.current = true;
        onCancel();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) {
        // Clicking elsewhere should disarm without stealing focus back to the trigger
        restoreFocusOnDisarmRef.current = false;
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [armed, onCancel]);

  const confirmBtnTone =
    tone === "positive"
      ? "bg-[var(--status-positive)] text-[var(--status-positive-fg)]"
      : tone === "neutral"
        ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
        : "bg-[var(--status-danger)] text-[var(--status-danger-fg)] hover:opacity-90";

  const triggerBtnTone =
    tone === "positive"
      ? "bg-[var(--status-positive)] text-[var(--status-positive-fg)] hover:opacity-90"
      : tone === "neutral"
        ? "border border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        : "border border-[var(--status-danger)] text-[var(--status-danger-text)] hover:bg-[var(--status-danger-soft)]";

  if (armed) {
    return (
      <span
        ref={groupRef}
        role="group"
        data-delete-armed="true"
        aria-label={`Confirm ${label.toLowerCase()}`}
        className="inline-flex items-center gap-1"
      >
        <button
          type="button"
          onClick={onConfirm}
          className={`h-6 rounded px-2 text-[11px] font-medium focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] ${confirmBtnTone}`}
        >
          {confirmLabel}
        </button>
        <button
          ref={cancelBtnRef}
          type="button"
          onClick={onCancel}
          className="h-6 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)]"
        >
          Cancel
        </button>
      </span>
    );
  }

  if (triggerLabel) {
    return (
      <span ref={triggerWrapRef} className="inline-flex">
        <button
          type="button"
          tabIndex={tabIndex}
          disabled={disabled}
          aria-label={label}
          onClick={onArm}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50 ${
            compact ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs"
          } ${triggerBtnTone}`}
        >
          {triggerIcon ?? <Trash2 className={iconClassName} strokeWidth={1.5} />}
          {triggerLabel}
        </button>
      </span>
    );
  }

  return (
    <span ref={triggerWrapRef} className="inline-flex">
      <IconButton
        size="xs"
        label={label}
        tone="danger"
        tabIndex={tabIndex}
        disabled={disabled}
        onClick={onArm}
      >
        {triggerIcon ?? <Trash2 className={iconClassName} strokeWidth={1.5} />}
      </IconButton>
    </span>
  );
}
