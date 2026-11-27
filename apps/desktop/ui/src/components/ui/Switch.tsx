interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-6 shrink-0 cursor-pointer items-center justify-center rounded focus-visible:outline-1 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full border transition-colors ${
          checked
            ? "border-[var(--accent)] bg-[var(--accent)]"
            : "border-[var(--border-strong)] bg-[var(--bg-app)]"
        }`}
      >
        <span
          className={`pointer-events-none block h-2.5 w-2.5 rounded-full transition-transform ${
            checked
              ? "translate-x-3.5 bg-white"
              : "translate-x-0.5 bg-[var(--text-muted)]"
          }`}
        />
      </span>
    </button>
  );
}
