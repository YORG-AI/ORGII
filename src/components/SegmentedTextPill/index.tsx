import type { ReactNode } from "react";

export interface SegmentedTextPillOption<T extends string> {
  disabled?: boolean;
  label: ReactNode;
  value: T;
}

export interface SegmentedTextPillProps<T extends string> {
  ariaLabel: string;
  className?: string;
  dataTestId?: string;
  onChange: (value: T) => void;
  options: SegmentedTextPillOption<T>[];
  value: T;
}

/** Compact text-only segmented control shared by creator setup rows. */
export default function SegmentedTextPill<T extends string>({
  ariaLabel,
  className = "",
  dataTestId,
  onChange,
  options,
  value,
}: SegmentedTextPillProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={`inline-flex h-[28px] shrink-0 items-center rounded-full bg-fill-2 p-0.5 text-[12px] font-medium ${className}`}
      data-testid={dataTestId}
      role="group"
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            className={`h-6 rounded-full px-2.5 py-0 transition-colors ${
              selected
                ? "bg-bg-2 text-text-1 shadow-sm"
                : "text-text-3 hover:text-text-1"
            } ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
            disabled={option.disabled}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
