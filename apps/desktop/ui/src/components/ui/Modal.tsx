import { useEffect, useRef } from "react";

interface ModalProps {
  ariaLabel: string;
  onClose: () => void;
  closeOnScrim?: boolean;
  closeOnEscape?: boolean;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  ariaLabel,
  onClose,
  closeOnScrim = true,
  closeOnEscape = true,
  children,
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;

    if (container) {
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null);
      // Prefer first body/form control over the header Close button so opening a dialog
      // never pops a "Close" tooltip or lets an accidental Enter immediately dismiss it.
      const preferred =
        focusables.find(
          (el) =>
            el.getAttribute("aria-label") !== "Close" &&
            el.getAttribute("aria-label") !== "Close dialog",
        ) ?? focusables[0];
      if (preferred) {
        preferred.focus();
      } else {
        container.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) {
        // Yield to nested open tooltips, dropdowns, menus, armed confirmations, or portalled popovers
        if (
          document.querySelector(
            '[role="tooltip"], [role="listbox"], [role="menu"], [data-delete-armed="true"]',
          )
        ) {
          return;
        }
        const openDialogs = document.querySelectorAll('[role="dialog"]');
        if (
          openDialogs.length > 1 &&
          container &&
          openDialogs[openDialogs.length - 1] !== container.parentElement
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && container) {
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (
            document.activeElement === first ||
            !container.contains(document.activeElement)
          ) {
            e.preventDefault();
            last.focus();
          }
        } else if (
          document.activeElement === last ||
          !container.contains(document.activeElement)
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [closeOnEscape]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(e) => {
        if (closeOnScrim && e.target === e.currentTarget) {
          onCloseRef.current();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="flex max-h-full w-full justify-center focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)]"
      >
        {children}
      </div>
    </div>
  );
}
