import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  isBareSingleKeyBadge,
  shouldSuppressFocusTooltip,
  useSingleKeyShortcutsEnabled,
} from "../../lib/shortcuts";

type TooltipSide = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: TooltipSide;
  className?: string;
  children: React.ReactElement;
}

export function Kbd({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <kbd
      className={`mono-num inline-flex items-center rounded border border-[var(--border-strong)] bg-[var(--bg-app)] px-1 py-0.5 text-[10px] leading-none font-medium text-[var(--text-secondary)] ${className}`}
    >
      {children}
    </kbd>
  );
}

export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  className = "",
  children,
}: TooltipProps) {
  const tooltipId = useId();
  const singleKeyEnabled = useSingleKeyShortcutsEnabled();
  const visibleShortcut =
    shortcut && (!isBareSingleKeyBadge(shortcut) || singleKeyEnabled)
      ? shortcut
      : undefined;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    resolvedSide: TooltipSide;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current || !coords) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (rect.left < margin) dx = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) {
      dx = window.innerWidth - margin - rect.right;
    }
    if (rect.top < margin) dy = margin - rect.top;
    else if (rect.bottom > window.innerHeight - margin) {
      dy = window.innerHeight - margin - rect.bottom;
    }
    if (dx !== 0 || dy !== 0) {
      setCoords((prev) =>
        prev ? { ...prev, left: prev.left + dx, top: prev.top + dy } : prev,
      );
    }
  }, [open, coords]);

  function computePosition() {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 6;
    const estWidth = Math.min(240, Math.max(72, label.length * 7 + (shortcut ? 48 : 20)));
    const estHeight = 28;
    const margin = 8;

    let resolvedSide = side;
    if (side === "bottom" && rect.bottom + gap + estHeight > window.innerHeight - margin) {
      resolvedSide = "top";
    } else if (side === "top" && rect.top - gap - estHeight < margin) {
      resolvedSide = "bottom";
    } else if (side === "right" && rect.right + gap + estWidth > window.innerWidth - margin) {
      resolvedSide = "left";
    } else if (side === "left" && rect.left - gap - estWidth < margin) {
      resolvedSide = "right";
    }

    let top = 0;
    let left = 0;
    if (resolvedSide === "right") {
      top = Math.max(
        margin + estHeight / 2,
        Math.min(window.innerHeight - margin - estHeight / 2, rect.top + rect.height / 2),
      );
      left = rect.right + gap;
    } else if (resolvedSide === "left") {
      top = Math.max(
        margin + estHeight / 2,
        Math.min(window.innerHeight - margin - estHeight / 2, rect.top + rect.height / 2),
      );
      left = rect.left - gap;
    } else if (resolvedSide === "top") {
      top = rect.top - gap;
      left = Math.max(
        margin + estWidth / 2,
        Math.min(window.innerWidth - margin - estWidth / 2, rect.left + rect.width / 2),
      );
    } else {
      top = rect.bottom + gap;
      left = Math.max(
        margin + estWidth / 2,
        Math.min(window.innerWidth - margin - estWidth / 2, rect.left + rect.width / 2),
      );
    }
    setCoords({ top, left, resolvedSide });
  }

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  function show() {
    cancelClose();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      computePosition();
      setOpen(true);
    }, 110);
  }

  const hideImmediate = useCallback(() => {
    cancelClose();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, [cancelClose]);

  function scheduleHide() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 120);
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.stopImmediatePropagation();
        hideImmediate();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, hideImmediate]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (closeTimerRef.current !== null)
        window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const effectiveSide = coords?.resolvedSide ?? side;
  const transformClass =
    effectiveSide === "right"
      ? "-translate-y-1/2"
      : effectiveSide === "left"
        ? "-translate-x-full -translate-y-1/2"
        : effectiveSide === "top"
          ? "-translate-x-1/2 -translate-y-full"
          : "-translate-x-1/2";

  const describedChild = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        "aria-describedby": open
          ? [children.props["aria-describedby"], tooltipId]
              .filter(Boolean)
              .join(" ")
          : children.props["aria-describedby"],
      })
    : children;

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={(e) => {
          // Only reveal tooltip on genuine user keyboard focus, not programmatic focus restoration
          if (
            !shouldSuppressFocusTooltip() &&
            e.target instanceof HTMLElement &&
            e.target.matches(":focus-visible")
          ) {
            show();
          }
        }}
        onBlur={hideImmediate}
        onMouseDown={hideImmediate}
        className={`inline-flex ${className}`}
      >
        {describedChild}
      </span>
      {open &&
        coords &&
        createPortal(
          <div
            id={tooltipId}
            ref={popoverRef}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleHide}
            style={{ top: coords.top, left: coords.left }}
            className={`pointer-events-auto fixed z-[100] flex max-w-[360px] items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] ${transformClass}`}
          >
            <span className="break-words">{label}</span>
            {visibleShortcut && <Kbd>{visibleShortcut}</Kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}

interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  label: string;
  shortcut?: string;
  side?: TooltipSide;
  active?: boolean;
  tone?: "default" | "accent" | "danger";
  size?: "xs" | "sm" | "md";
}

export function IconButton({
  label,
  shortcut,
  side = "bottom",
  active,
  tone = "default",
  size = "sm",
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  const sizeClass =
    size === "xs"
      ? "h-6 w-6"
      : size === "md"
        ? "h-8 w-8"
        : "h-7 w-7";

  const toneClass =
    tone === "accent"
      ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
      : tone === "danger"
        ? "text-[var(--text-secondary)] hover:bg-[var(--status-danger-soft)] hover:text-[var(--status-danger-text)]"
        : active
          ? "border border-[var(--border-strong)] bg-[var(--bg-active)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";

  return (
    <Tooltip label={label} shortcut={shortcut} side={side}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-35 ${sizeClass} ${toneClass} ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
