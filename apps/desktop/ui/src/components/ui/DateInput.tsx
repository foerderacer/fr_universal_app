import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Tooltip";

interface DateInputProps {
  id?: string;
  value: string;
  onChange: (isoDate: string) => void;
  required?: boolean;
  ariaLabel?: string;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseIsoDate(
  iso: string,
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function DateInput({
  id,
  value,
  onChange,
  required = false,
  ariaLabel = "Date",
}: DateInputProps) {
  const parsed = useMemo(() => parseIsoDate(value), [value]);
  const now = new Date();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(parsed?.year ?? now.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? now.getMonth());
  const [focusedDay, setFocusedDay] = useState<number>(
    parsed?.day ?? now.getDate(),
  );
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
      setFocusedDay(parsed.day);
    }
  }, [parsed]);

  function openCalendar() {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const popW = 236;
      const popH = 264;
      const fitsBelow = rect.bottom + 4 + popH <= window.innerHeight - 8;
      const left = Math.max(
        8,
        Math.min(window.innerWidth - popW - 8, rect.left),
      );
      setCoords({
        top: fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - popH - 4),
        left,
      });
    }
    setOpen(true);
    requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>('button[role="gridcell"][tabindex="0"]')
        ?.focus();
    });
  }

  useEffect(() => {
    if (!open) return;
    const shiftDayInEffect = (deltaDays: number) => {
      const next = new Date(viewYear, viewMonth, focusedDay + deltaDays);
      setViewYear(next.getFullYear());
      setViewMonth(next.getMonth());
      setFocusedDay(next.getDate());
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
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
        inputRef.current?.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      } else if (
        document.activeElement !== inputRef.current &&
        popoverRef.current?.contains(document.activeElement) &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "Home" ||
          e.key === "End" ||
          e.key === "Enter" ||
          e.key === " ")
      ) {
        // Let Enter/Space activate focused month-navigation buttons inside the calendar header
        const activeBtn =
          document.activeElement instanceof HTMLButtonElement &&
          popoverRef.current?.contains(document.activeElement) &&
          !document.activeElement.closest('[role="grid"]');
        if ((e.key === "Enter" || e.key === " ") && activeBtn) {
          return;
        }
        e.preventDefault();
        let nextDay = focusedDay;
        if (e.key === "ArrowLeft") {
          shiftDayInEffect(-1);
          nextDay = -1;
        } else if (e.key === "ArrowRight") {
          shiftDayInEffect(1);
          nextDay = -1;
        } else if (e.key === "ArrowUp") {
          shiftDayInEffect(-7);
          nextDay = -1;
        } else if (e.key === "ArrowDown") {
          shiftDayInEffect(7);
          nextDay = -1;
        } else if (e.key === "Home") {
          nextDay = 1;
          setFocusedDay(1);
        } else if (e.key === "End") {
          nextDay = new Date(viewYear, viewMonth + 1, 0).getDate();
          setFocusedDay(nextDay);
        } else if (e.key === "Enter" || e.key === " ") {
          onChange(toIso(viewYear, viewMonth, focusedDay));
          setOpen(false);
          inputRef.current?.focus();
          return;
        }
        if (nextDay > 0) {
          requestAnimationFrame(() => {
            popoverRef.current
              ?.querySelector<HTMLButtonElement>(`button[data-day="${nextDay}"]`)
              ?.focus();
          });
        } else {
          requestAnimationFrame(() => {
            popoverRef.current
              ?.querySelector<HTMLButtonElement>('button[role="gridcell"][tabindex="0"]')
              ?.focus();
          });
        }
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, viewYear, viewMonth, focusedDay, onChange]);

  const calendarWeeks = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const startWeekday = (first.getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells: Array<number | null> = [];
    for (let i = 0; i < startWeekday; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: Array<Array<number | null>> = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }
    return weeks;
  }, [viewYear, viewMonth]);

  function shiftMonth(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
    const maxDay = new Date(
      next.getFullYear(),
      next.getMonth() + 1,
      0,
    ).getDate();
    setFocusedDay((prev) => Math.min(prev, maxDay));
  }

  const [touched, setTouched] = useState(false);
  const todayIso = toIso(now.getFullYear(), now.getMonth(), now.getDate());
  const invalidFormat =
    touched && value.trim().length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(value.trim());

  return (
    <div ref={containerRef} className="w-full">
      <div className="relative flex items-center">
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="numeric"
          required={required}
          pattern="\d{4}-\d{2}-\d{2}"
          aria-label={ariaLabel}
          aria-invalid={invalidFormat || undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="YYYY-MM-DD"
          className={`mono-num h-8 w-full rounded-md border bg-[var(--bg-surface)] pr-8 pl-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none ${
            invalidFormat
              ? "border-[var(--status-danger)]"
              : "border-[var(--border-strong)]"
          }`}
        />
        <div className="absolute right-1">
          <IconButton
            size="xs"
            label="Open calendar"
            onClick={() => (open ? setOpen(false) : openCalendar())}
          >
            <Calendar className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>
      {invalidFormat && (
        <p className="mt-1 text-[11px] text-[var(--status-danger-text)]">
          Use YYYY-MM-DD or pick a date from the calendar.
        </p>
      )}

      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose date"
            style={{ top: coords.top, left: coords.left }}
            className="fixed z-[115] w-[236px] rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5 text-xs"
          >
            <div className="mb-2 flex items-center justify-between">
              <IconButton
                size="xs"
                label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
              <span className="text-[11px] font-medium text-[var(--text-primary)]">
                {MONTHS[viewMonth]} {viewYear}
              </span>
              <IconButton
                size="xs"
                label="Next month"
                onClick={() => shiftMonth(1)}
              >
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>

            <div
              role="grid"
              aria-label={`${MONTHS[viewMonth]} ${viewYear}`}
            >
              <div
                role="row"
                className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] font-medium text-[var(--text-muted)]"
              >
                {WEEKDAYS.map((w) => (
                  <span key={w} role="columnheader" className="py-0.5">
                    {w}
                  </span>
                ))}
              </div>

              <div className="space-y-0.5">
                {calendarWeeks.map((week, wIdx) => (
                  <div
                    key={`w-${wIdx}`}
                    role="row"
                    className="grid grid-cols-7 gap-0.5"
                  >
                    {week.map((day, idx) => {
                      if (day === null) {
                        return (
                          <span
                            key={`e-${wIdx}-${idx}`}
                            role="gridcell"
                            aria-disabled="true"
                            className="h-7"
                          />
                        );
                      }
                      const iso = toIso(viewYear, viewMonth, day);
                      const isSelected = iso === value;
                      const isFocused = day === focusedDay;
                      const isToday = iso === todayIso;
                      return (
                        <button
                          key={iso}
                          type="button"
                          role="gridcell"
                          data-day={day}
                          aria-label={iso}
                          aria-selected={isSelected}
                          aria-current={isToday ? "date" : undefined}
                          tabIndex={isFocused ? 0 : -1}
                          onFocus={() => setFocusedDay(day)}
                          onClick={() => {
                            onChange(iso);
                            setOpen(false);
                            inputRef.current?.focus();
                          }}
                          className={`mono-num flex h-7 w-7 items-center justify-center rounded text-[11px] transition-colors ${
                            isSelected
                              ? "bg-[var(--accent)] font-medium text-white"
                              : isToday && isFocused
                                ? "border border-[var(--accent)] bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]"
                                : isToday
                                  ? "border border-[var(--accent)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                  : isFocused
                                    ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
