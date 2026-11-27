import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  ariaLabel?: string;
}

export function Combobox({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
}: ComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState<number>(-1);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const unique = Array.from(new Set(suggestions.filter(Boolean)));
    if (!q) return unique;
    return unique.filter((s) => s.toLowerCase().includes(q));
  }, [suggestions, value]);

  function openMenu() {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) {
      const estH = Math.min(filtered.length * 30 + 12, 200);
      const fitsBelow = rect.bottom + 4 + estH <= window.innerHeight - 8;
      setCoords({
        top: fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - estH - 4),
        left: rect.left,
        width: rect.width,
      });
    }
    setHighlightedIdx(-1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapperRef.current?.contains(target) ||
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
      } else if (e.key === "Tab") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || highlightedIdx < 0) return;
    document
      .getElementById(`${listboxId}-opt-${highlightedIdx}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIdx, listboxId]);

  const activeDescendantId =
    open && highlightedIdx >= 0 && highlightedIdx < filtered.length
      ? `${listboxId}-opt-${highlightedIdx}`
      : undefined;

  return (
    <div ref={wrapperRef} className="relative flex items-center">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-owns={open ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={value}
        onClick={() => {
          if (!open) openMenu();
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setHighlightedIdx(-1);
          if (!open) openMenu();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) {
              openMenu();
              setHighlightedIdx(0);
            } else if (filtered.length > 0) {
              setHighlightedIdx((prev) => (prev + 1) % filtered.length);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              openMenu();
              setHighlightedIdx(Math.max(0, filtered.length - 1));
            } else if (filtered.length > 0) {
              setHighlightedIdx(
                (prev) => (prev <= 0 ? filtered.length - 1 : prev - 1),
              );
            }
          } else if (
            e.key === "Enter" &&
            open &&
            highlightedIdx >= 0 &&
            filtered[highlightedIdx]
          ) {
            e.preventDefault();
            onChange(filtered[highlightedIdx]);
            setOpen(false);
          } else if (e.key === "Tab") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] pr-7 pl-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Toggle suggestions"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
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
            aria-label={ariaLabel ?? "Suggestions"}
            style={{
              top: coords.top,
              left: coords.left,
              minWidth: coords.width,
            }}
            className="fixed z-[115] max-h-48 overflow-y-auto rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1"
          >
            {filtered.length === 0 ? (
              <div
                role="option"
                aria-disabled="true"
                aria-selected="false"
                className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]"
              >
                No matching options
              </div>
            ) : (
              filtered.map((item, idx) => {
                const selected =
                  item.toLowerCase() === value.trim().toLowerCase();
                const highlighted = idx === highlightedIdx;
                return (
                  <button
                    id={`${listboxId}-opt-${idx}`}
                    key={item}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseEnter={() => setHighlightedIdx(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(item);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                        : highlighted
                          ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <span className="truncate">{item}</span>
                    {selected && (
                      <Check
                        className="h-3 w-3 shrink-0 text-[var(--accent-text)]"
                        strokeWidth={1.5}
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
