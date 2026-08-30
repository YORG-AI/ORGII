import type { ReactNode } from "react";

export interface SegmentedTextPillOption<T extends string> {
  disabled?: boolean;
  label: ReactNode;
  value: T;
}

export type SegmentedTextPillSize = "small" | "default";

export interface SegmentedTextPillProps<T extends string> {
  ariaLabel: string;
  className?: string;
  dataTestId?: string;
  onChange: (value: T) => void;
  options: SegmentedTextPillOption<T>[];
  size?: SegmentedTextPillSize;
  value: T;
}

const CONTAINER_SIZE_CLASSES: Record<SegmentedTextPillSize, string> = {
  small: "h-6 text-[11px]",
  default: "h-[28px] text-[12px]",
};

const BUTTON_SIZE_CLASSES: Record<SegmentedTextPillSize, string> = {
  small: "h-5 px-2",
  default: "h-6 px-2.5",
};

/** Compact text-only segmented control shared by creator setup rows. */
export default function SegmentedTextPill<T extends string>({
  ariaLabel,
  className = "",
  dataTestId,
  onChange,
  options,
  size = "default",
  value,
}: SegmentedTextPillProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center rounded-full bg-fill-2 p-0.5 font-medium ${CONTAINER_SIZE_CLASSES[size]} ${className}`}
      data-testid={dataTestId}
      role="group"
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            className={`rounded-full py-0 transition-colors ${BUTTON_SIZE_CLASSES[size]} ${
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
