/**
 * Switch Component
 *
 * Native switch component with clean, minimal design.
 *
 *
 * Features:
 * - Full API compatibility
 * - Clean, minimal design
 * - Smooth animations
 * - Loading states
 * - Disabled states
 * - Custom colors
 * - Size variants
 * - Accessibility label indicator
 *
 * @example
 * ```tsx
 * import Switch from "@src/components/Switch";
 *
 * // Simple switch
 * <Switch checked={checked} onCheckedChange={setChecked} />
 *
 * // With text
 * <Switch
 *   checked={checked}
 *   onCheckedChange={setChecked}
 *   checkedText="ON"
 *   uncheckedText="OFF"
 * />
 *
 * // With accessibility label
 * <Switch checked={checked} onCheckedChange={setChecked} showAxLabel />
 * ```
 */
import React, { forwardRef, useCallback, useState } from "react";

import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

interface SwitchProps {
  /**
   * Checked state (controlled)
   */
  checked?: boolean;

  /**
   * Default checked state (uncontrolled)
   */
  defaultChecked?: boolean;

  /**
   * Checked-state change handler
   */
  onCheckedChange?: (checked: boolean, event: React.MouseEvent) => void;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Loading state
   */
  loading?: boolean;

  /**
   * Visual mixed state for parent toggles where only some children are enabled.
   */
  mixed?: boolean;

  /**
   * Switch size
   * @default 'default'
   */
  size?: "small" | "default" | "large";

  /**
   * Switch type (color)
   * @default 'primary'
   */
  type?: "primary" | "success" | "warning" | "danger";

  /**
   * Text when checked
   */
  checkedText?: React.ReactNode;

  /**
   * Text when unchecked
   */
  uncheckedText?: React.ReactNode;

  /**
   * Icon when checked
   */
  checkedIcon?: React.ReactNode;

  /**
   * Icon when unchecked
   */
  uncheckedIcon?: React.ReactNode;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Accessible label for icon-only switches.
   */
  ariaLabel?: string;

  /**
   * Stable selector for rendered UI tests.
   */
  dataTestId?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      defaultChecked = false,
      onCheckedChange,
      disabled = false,
      loading = false,
      mixed = false,
      size = "default",
      type = "primary",
      checkedText,
      uncheckedText,
      checkedIcon,
      uncheckedIcon,
      className = "",
      ariaLabel,
      dataTestId,
      style,
    },
    ref
  ) => {
    const { isDark } = useCurrentTheme();
    const [internalChecked, setInternalChecked] = useState(defaultChecked);

    const isControlled = checked !== undefined;
    const currentChecked = isControlled ? checked : internalChecked;

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        if (disabled || loading) {
          e.preventDefault();
          return;
        }

        const newChecked = !currentChecked;

        if (!isControlled) {
          setInternalChecked(newChecked);
        }

        onCheckedChange?.(newChecked, e);
      },
      [disabled, loading, currentChecked, isControlled, onCheckedChange]
    );

    const classes = [
      "switch",
      `switch-${size}`,
      `switch-${type}`,
      currentChecked && "switch-checked",
      mixed && "switch-mixed",
      disabled && "switch-disabled",
      loading && "switch-loading",
      isDark && "switch-dark",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const currentIcon = currentChecked ? checkedIcon : uncheckedIcon;
    const currentText = currentChecked ? checkedText : uncheckedText;

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={currentChecked}
        aria-label={ariaLabel}
        disabled={disabled || loading}
        className={classes}
        data-testid={dataTestId}
        style={style}
        onClick={handleClick}
      >
        {/* Track background */}
        <span className="switch-track">
          <span className="switch-track-overlay" />
        </span>

        {/* Knob/Handle */}
        <span className="switch-handle">
          {loading ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={SPINNER_TOKENS.small}
              className="animate-spin"
            />
          ) : (
            currentIcon
          )}
        </span>

        {/* Text labels */}
        {(currentText || (checkedText && uncheckedText)) && (
          <span className="switch-text">{currentText}</span>
        )}
      </button>
    );
  }
);

Switch.displayName = "Switch";

export default Switch;
