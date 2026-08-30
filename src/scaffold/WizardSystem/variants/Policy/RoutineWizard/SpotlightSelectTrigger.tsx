/**
 * SpotlightSelectTrigger
 *
 * A trigger that visually mimics the `Select` component but, instead of
 * opening an inline dropdown, fires `onClick` so the caller can open a
 * GlobalSpotlight palette (UnifiedModelPalette, WorkspacePalette, or a custom
 * routine-scoped palette).
 *
 * Why not reuse `Select` directly? `Select` owns its own dropdown engine
 * and renders an inline option list. Routine picks need the full spotlight
 * UI (two-column model picker, repo + workspace mixed list, etc.) which
 * `Select` cannot host. This trigger keeps the visual language (border,
 * height, hover, focus ring, chevron) identical to `Select` so settings
 * rows stay consistent.
 */
import React, { forwardRef } from "react";

import "@src/components/Select/index.scss";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

export interface SpotlightSelectTriggerProps {
  /** Currently displayed value (e.g. selected model label). */
  value?: React.ReactNode;
  /** Placeholder shown when value is empty. */
  placeholder?: string;
  /** Click handler — open the spotlight palette here. */
  onClick: () => void;
  /** Whether the spotlight palette is currently open (drives focus ring). */
  active?: boolean;
  /** @default 'default' */
  size?: "mini" | "small" | "default" | "large";
  disabled?: boolean;
  error?: boolean;
  /** Optional left-edge icon (e.g. ModelIcon). */
  prefix?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Stable selector for E2E tests. */
  dataTestId?: string;
  /** Accessible label override. */
  ariaLabel?: string;
}

/**
 * Visual parity with `Select` is achieved by reusing the same CSS classes
 * (`select-wrapper`, `select-selector`, `select-size-*`). The wrapper is a
 * native `<button>` so the trigger is keyboard-reachable and dispatches
 * Enter/Space without bespoke handling.
 */
const SpotlightSelectTrigger = forwardRef<
  HTMLButtonElement,
  SpotlightSelectTriggerProps
>(function SpotlightSelectTrigger(
  {
    value,
    placeholder,
    onClick,
    active = false,
    size = "default",
    disabled = false,
    error = false,
    prefix,
    className = "",
    style,
    dataTestId,
    ariaLabel,
  },
  ref
) {
  const { isDark } = useCurrentTheme();

  const wrapperClasses = [
    "select-wrapper",
    `select-size-${size}`,
    error && "select-error",
    disabled && "select-disabled",
    active && "select-open",
    isDark && "select-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const hasValue = value !== undefined && value !== null && value !== "";

  return (
    <button
      ref={ref}
      type="button"
      className={wrapperClasses}
      style={{
        ...style,
        appearance: "none",
        background: "transparent",
        border: "none",
        padding: 0,
        textAlign: "left",
      }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-testid={dataTestId}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={active}
    >
      <div className="select-selector rounded-lg border border-solid border-border-2 bg-bg-2">
        {prefix ? <span className="select-prefix">{prefix}</span> : null}
        {hasValue ? (
          <span className="select-value">{value}</span>
        ) : (
          <span className="select-placeholder">{placeholder}</span>
        )}
        <div className="select-suffix">
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={16}
            className={`select-arrow shrink-0 transition-transform ${
              active ? "rotate-180" : ""
            }`}
          />
        </div>
      </div>
    </button>
  );
});

export default SpotlightSelectTrigger;
