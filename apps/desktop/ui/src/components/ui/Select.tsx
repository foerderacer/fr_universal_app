import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  mono?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Select({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  size = "md",
  mono = false,
  ariaLabel,
  className = "",
}: SelectProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState<number>(0);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  function openMenu(initialIndex?: number) {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const estimatedHeight = Math.min(options.length * 30 + 12, 224);
      const fitsBelow =
        rect.bottom + 4 + estimatedHeight <= window.innerHeight - 8;
      setCoords({
        top: fitsBelow
          ? rect.bottom + 4
          : Math.max(8, rect.top - estimatedHeight - 4),
        left: rect.left,
        width: rect.width,
      });
    }
    const idx =
      initialIndex !== undefined
        ? initialIndex
        : selectedIndex >= 0
          ? selectedIndex
          : 0;
    setHighlightedIdx(Math.max(0, Math.min(options.length - 1, idx)));
    setOpen(true);
  }

  function commitIndex(idx: number) {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIdx((prev) =>
          options.length === 0 ? 0 : (prev + 1) % options.length,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIdx((prev) =>
          options.length === 0
            ? 0
            : (prev - 1 + options.length) % options.length,
        );
      } else if (e.key === "Home") {
        e.preventDefault();
        setHighlightedIdx(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setHighlightedIdx(Math.max(0, options.length - 1));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const opt = options[highlightedIdx];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, options, highlightedIdx, onChange]);

  useEffect(() => {
    if (!open || highlightedIdx < 0) return;
    document
      .getElementById(`${listboxId}-opt-${highlightedIdx}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIdx, listboxId]);

  const heightClass = size === "sm" ? "h-7 px-2" : "h-8 px-2.5";
  const activeDescendantId =
    open && options[highlightedIdx]
      ? `${listboxId}-opt-${highlightedIdx}`
      : undefined;

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-owns={open ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu(
              e.key === "ArrowDown"
                ? Math.min(options.length - 1, Math.max(0, selectedIndex))
                : Math.max(0, selectedIndex),
            );
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu();
          }
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] text-left text-xs transition-colors hover:border-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${heightClass} ${
          mono ? "mono-num" : ""
        } ${className}`}
      >
        <span
          className={`truncate ${
            selectedOption
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={1.5}
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            id={listboxId}
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel ?? "Options"}
            style={{
              top: coords.top,
              left: coords.left,
              minWidth: coords.width,
            }}
            className="fixed z-[110] max-h-56 overflow-y-auto rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1"
          >
            {options.map((opt, idx) => {
              const selected = opt.value === value;
              const highlighted = idx === highlightedIdx;
              return (
                <button
                  id={`${listboxId}-opt-${idx}`}
                  key={opt.value}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  onMouseEnter={() => setHighlightedIdx(idx)}
                  onClick={() => commitIndex(idx)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    mono ? "mono-num" : ""
                  } ${
                    selected
                      ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                      : highlighted
                        ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {selected && (
                    <Check
                      className="h-3 w-3 shrink-0 text-[var(--accent-text)]"
                      strokeWidth={1.5}
                    />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
