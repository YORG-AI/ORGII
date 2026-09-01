/**
 * SelectGhostTrigger
 *
 * Ghost-appearance trigger that visually matches `Select` with
 * `size="small"`, `appearance="ghost"`, and `radius="lg"` — the same
 * configuration used by Source Control header filter selects.
 *
 * Use when a custom droplist (`Dropdown` droplist mode, spotlight palette,
 * etc.) must share the compact workstation-header select appearance
 * without adopting `Select`'s built-in option panel.
 *
 * Renders via design-system `Button` (not a raw `<button>`). Select SCSS
 * classes provide the compact trigger dimensions and text-state styling.
 */
import React, { forwardRef } from "react";

import Button from "@src/components/Button";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { RADIUS_CLASS_MAP } from "./config";
import "./index.scss";

export interface SelectGhostTriggerProps {
  /** Trigger body (label, breadcrumb segments, count text, etc.). */
  value: React.ReactNode;
  /** Whether the associated panel is open (drives text color + chevron). */
  open?: boolean;
  /** @default 'small' */
  size?: "mini" | "small" | "default" | "large";
  /** @default 'lg' */
  radius?: keyof typeof RADIUS_CLASS_MAP;
  disabled?: boolean;
  className?: string;
  selectorClassName?: string;
  style?: React.CSSProperties;
  title?: string;
  ariaLabel?: string;
  dataTestId?: string;
}

/** Reset Button layout so `select-wrapper` / `select-selector` SCSS wins. */
const BUTTON_RESET_CLASS =
  "inline-block! h-auto! min-h-0! justify-start! items-stretch! p-0! font-normal! border-0! bg-transparent! [&>span]:contents";

const SelectGhostTrigger = forwardRef<
  HTMLButtonElement,
  SelectGhostTriggerProps
>(function SelectGhostTrigger(
  {
    value,
    open = false,
    size = "small",
    radius = "lg",
    disabled = false,
    className = "",
    selectorClassName = "",
    style,
    title,
    ariaLabel,
    dataTestId,
  },
  ref
) {
  const { isDark } = useCurrentTheme();
  const radiusClass = RADIUS_CLASS_MAP[radius];

  const wrapperClasses = [
    "select-wrapper",
    "select-ghost",
    `select-size-${size}`,
    disabled && "select-disabled",
    open && "select-open",
    isDark && "select-dark",
    BUTTON_RESET_CLASS,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Button
      ref={ref}
      variant="tertiary"
      appearance="ghost"
      size={size}
      disabled={disabled}
      className={wrapperClasses}
      style={{
        height: "auto",
        padding: 0,
        gap: 0,
        textAlign: "left",
        ...style,
      }}
      title={title}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      data-testid={dataTestId}
    >
      <div className={`select-selector ${radiusClass} ${selectorClassName}`}>
        <span className="select-value">{value}</span>
        <div className="select-suffix">
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={12}
            className={`select-arrow shrink-0 text-text-3 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      </div>
    </Button>
  );
});

export default SelectGhostTrigger;
