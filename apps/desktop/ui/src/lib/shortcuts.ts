import { useEffect, useState } from "react";

export const ACTIVE_OVERLAY_SELECTOR =
  '[role="dialog"], [role="listbox"], [role="menu"], [data-delete-armed="true"]';

const SINGLE_KEY_SHORTCUTS_KEY = "fr.workspace.singleKeyShortcuts.v1";
const SINGLE_KEY_SHORTCUTS_EVENT = "fr:single-key-shortcuts-changed";

/** WCAG 2.1.4 Level A preference allowing users to disable bare single-character shortcuts. */
export function areSingleKeyShortcutsEnabled(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new Event(SINGLE_KEY_SHORTCUTS_EVENT));
  } catch {
    // Ignore storage write errors in restricted webviews.
  }
}

export function useSingleKeyShortcutsEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => areSingleKeyShortcutsEnabled());
  useEffect(() => {
    const sync = () => setEnabled(areSingleKeyShortcutsEnabled());
    window.addEventListener(SINGLE_KEY_SHORTCUTS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SINGLE_KEY_SHORTCUTS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return enabled;
}

/** True for bare single-character shortcut badges (no Alt/Ctrl/Cmd/Enter/Esc). */
export function isBareSingleKeyBadge(shortcut: string): boolean {
  const trimmed = shortcut.trim();
  if (!trimmed) return false;
  if (
    trimmed.includes("+") ||
    trimmed.includes("Alt") ||
    trimmed.includes("Ctrl") ||
    trimmed.includes("⌘") ||
    trimmed.includes("⌥") ||
    trimmed.includes("Shift") ||
    trimmed.includes("Enter") ||
    trimmed.includes("Esc") ||
    trimmed.includes("↵")
  ) {
    return false;
  }
  return trimmed.length === 1;
}

export function hasActiveOverlay(): boolean {
  return document.querySelector(ACTIVE_OVERLAY_SELECTOR) !== null;
}

const ARROW_BLOCK_SELECTOR =
  'aside, header, [role="radiogroup"], [role="toolbar"], [role="separator"]';

/** Shared guard preventing global canvas/list arrow handlers from hijacking pane chrome or APG widgets. */
export function isBlockedArrowScope(activeEl: Element | null): boolean {
  return (
    activeEl instanceof HTMLElement &&
    activeEl.closest(ARROW_BLOCK_SELECTOR) !== null
  );
}

let suppressTooltipUntil = 0;

/** Prevent programmatic focus restoration (e.g. pane collapse) from popping a spurious tooltip. */
export function suppressNextFocusTooltip(durationMs = 200): void {
  suppressTooltipUntil = Date.now() + durationMs;
}

export function shouldSuppressFocusTooltip(): boolean {
  return Date.now() < suppressTooltipUntil;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** APG ArrowLeft/ArrowRight/Home/End keyboard traversal for role="toolbar" containers. */
export function handleToolbarKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (
    e.key !== "ArrowRight" &&
    e.key !== "ArrowLeft" &&
    e.key !== "Home" &&
    e.key !== "End"
  ) {
    return;
  }
  const buttons = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  );
  if (buttons.length === 0) return;
  const active = document.activeElement as HTMLButtonElement | null;
  const idx = active ? buttons.indexOf(active) : -1;
  if (idx === -1) return;
  e.preventDefault();
  e.stopPropagation();
  let nextIdx = idx;
  if (e.key === "ArrowRight") nextIdx = (idx + 1) % buttons.length;
  else if (e.key === "ArrowLeft")
    nextIdx = (idx - 1 + buttons.length) % buttons.length;
  else if (e.key === "Home") nextIdx = 0;
  else if (e.key === "End") nextIdx = buttons.length - 1;
  buttons[nextIdx]?.focus();
}

/** APG ArrowUp/ArrowDown/Home/End keyboard traversal for vertical role="toolbar" rails. */
export function handleVerticalToolbarKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
): void {
  if (
    e.key !== "ArrowDown" &&
    e.key !== "ArrowUp" &&
    e.key !== "Home" &&
    e.key !== "End"
  ) {
    return;
  }
  const buttons = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  );
  if (buttons.length === 0) return;
  const active = document.activeElement as HTMLButtonElement | null;
  const idx = active ? buttons.indexOf(active) : -1;
  if (idx === -1) return;
  e.preventDefault();
  e.stopPropagation();
  let nextIdx = idx;
  if (e.key === "ArrowDown") nextIdx = (idx + 1) % buttons.length;
  else if (e.key === "ArrowUp")
    nextIdx = (idx - 1 + buttons.length) % buttons.length;
  else if (e.key === "Home") nextIdx = 0;
  else if (e.key === "End") nextIdx = buttons.length - 1;
  buttons[nextIdx]?.focus();
}
