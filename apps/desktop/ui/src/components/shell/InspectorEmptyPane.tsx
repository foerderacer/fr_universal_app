import type { LucideIcon } from "lucide-react";

interface InspectorEmptyPaneProps {
  icon: LucideIcon;
  title: string;
  description: string;
  footerLeft: string;
  footerRight: string;
}

/**
 * Shared empty-state inspector panel used across modules (Files, Finance)
 * with canonical h-10 header and h-8 monospace status footer.
 */
export function InspectorEmptyPane({
  icon: Icon,
  title,
  description,
  footerLeft,
  footerRight,
}: InspectorEmptyPaneProps) {
  return (
    <div className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border-hairline)] px-3">
        <span className="text-xs font-medium text-[var(--text-primary)]">
          Inspector
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Icon
          className="mb-2.5 h-6 w-6 text-[var(--text-muted)] opacity-60"
          strokeWidth={1.5}
        />
        <p className="text-xs font-medium text-[var(--text-secondary)]">
          {title}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {description}
        </p>
      </div>
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span className="truncate">{footerLeft}</span>
        <span className="shrink-0">{footerRight}</span>
      </div>
    </div>
  );
}
