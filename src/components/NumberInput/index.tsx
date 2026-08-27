/**
 * NumberInput Component
 *
 * Numeric input with increment/decrement buttons.
 *
 * Features:
 * - Min/max/step constraints
 * - Increment/decrement buttons (right or sides layout)
 * - Suffix support (e.g., "px", "ms")
 * - Multiple sizes
 * - Matches Input component styling
 *
 * @example
 * ```tsx
 * import NumberInput from "@src/components/NumberInput";
 *
 * <NumberInput
 *   value={14}
 *   min={10}
 *   max={20}
 *   suffix="px"
 *   onValueChange={setFontSize}
 * />
 * <NumberInput value={1.5} min={1} max={2} step={0.1} />
 * <NumberInput value={500} controlsPosition="sides" />
 * ```
 */
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import React, { forwardRef, useCallback, useState } from "react";

import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

export interface NumberInputProps {
  /**
   * Current value
   */
  value?: number;

  /**
   * Default value (uncontrolled)
   */
  defaultValue?: number;

  /**
   * Called when a parsed, clamped value is committed
   */
  onValueChange?: (value: number | undefined) => void;

  /**
   * Minimum value
   */
  min?: number;

  /**
   * Maximum value
   */
  max?: number;

  /**
   * Step increment
   * @default 1
   */
  step?: number;

  /**
   * Input size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Suffix text (e.g., "px", "ms")
   */
  suffix?: string;

  /**
   * Controls position
   * - "right": Stacked up/down buttons on the right (default)
   * - "sides": Minus on left, plus on right
   * @default 'right'
   */
  controlsPosition?: "right" | "sides";

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Error state
   */
  error?: boolean;

  /**
   * Placeholder text
   */
  placeholder?: string;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Stable selector for rendered UI tests.
   */
  dataTestId?: string;
}

const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      defaultValue,
      onValueChange,
      min,
      max,
      step = 1,
      size = "default",
      suffix,
      controlsPosition = "right",
      disabled = false,
      error = false,
      placeholder,
      className = "",
      style,
      dataTestId,
    },
    ref
  ) => {
    const { isDark } = useCurrentTheme();
    const [internalValue, setInternalValue] = useState<number | undefined>(
      defaultValue
    );
    const [isFocused, setIsFocused] = useState(false);

    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : internalValue;

    // Draft string while the user is typing — null means not editing
    const [draft, setDraft] = useState<string | null>(null);

    // Clamp value to min/max bounds
    const clampValue = useCallback(
      (val: number): number => {
        let clamped = val;
        if (min !== undefined) clamped = Math.max(min, clamped);
        if (max !== undefined) clamped = Math.min(max, clamped);
        return clamped;
      },
      [min, max]
    );

    // Round to step precision
    const roundToStep = useCallback(
      (val: number): number => {
        const precision = step.toString().split(".")[1]?.length || 0;
        return Number(val.toFixed(precision));
      },
      [step]
    );

    const updateValue = useCallback(
      (newValue: number | undefined) => {
        if (!isControlled) {
          setInternalValue(newValue);
        }
        onValueChange?.(newValue);
      },
      [isControlled, onValueChange]
    );

    // While focused: just update the draft string, no parsing/clamping
    const handleInputChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
      },
      []
    );

    const handleFocus = useCallback(() => {
      setIsFocused(true);
      // Seed the draft with the current display value
      setDraft(currentValue !== undefined ? String(currentValue) : "");
    }, [currentValue]);

    // On blur: parse, clamp, commit — or restore previous if empty/invalid
    const handleBlur = useCallback(
      (event: React.FocusEvent<HTMLInputElement>) => {
        setIsFocused(false);
        const cleaned = event.currentTarget.value.trim().replace(/,/g, "");
        if (cleaned !== "") {
          const parsed = parseFloat(cleaned);
          if (!isNaN(parsed)) {
            const nextValue = roundToStep(clampValue(parsed));
            if (nextValue !== currentValue) updateValue(nextValue);
          }
        }
        setDraft(null);
      },
      [currentValue, clampValue, roundToStep, updateValue]
    );

    const increment = useCallback(() => {
      if (disabled) return;
      setDraft(null);
      const base = currentValue ?? min ?? 0;
      const newValue = roundToStep(clampValue(base + step));
      updateValue(newValue);
    }, [
      disabled,
      currentValue,
      min,
      step,
      clampValue,
      roundToStep,
      updateValue,
    ]);

    const decrement = useCallback(() => {
      if (disabled) return;
      setDraft(null);
      const base = currentValue ?? max ?? 0;
      const newValue = roundToStep(clampValue(base - step));
      updateValue(newValue);
    }, [
      disabled,
      currentValue,
      max,
      step,
      clampValue,
      roundToStep,
      updateValue,
    ]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          increment();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          decrement();
        }
      },
      [increment, decrement]
    );

    const wrapperClasses = [
      "number-input-wrapper",
      `number-input-size-${size}`,
      `number-input-controls-${controlsPosition}`,
      error && "number-input-error",
      disabled && "number-input-disabled",
      isFocused && "number-input-focused",
      isDark && "number-input-dark",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    // While focused show raw draft; otherwise show comma-formatted value
    const displayValue =
      draft !== null
        ? draft
        : currentValue !== undefined
          ? currentValue.toLocaleString("en-US")
          : "";

    const isAtMin = min !== undefined && (currentValue ?? 0) <= min;
    const isAtMax = max !== undefined && (currentValue ?? 0) >= max;

    // Sides layout: - [value] +
    if (controlsPosition === "sides") {
      return (
        <div className={wrapperClasses} style={style}>
          <div className="number-input-inner rounded-lg bg-bg-2">
            <button
              type="button"
              className="number-input-btn-side number-input-btn-left"
              onClick={decrement}
              disabled={disabled || isAtMin}
              tabIndex={-1}
            >
              <Minus size={14} strokeWidth={1.5} />
            </button>

            <div className="number-input-value-group">
              <input
                ref={ref}
                type="text"
                inputMode="decimal"
                size={Math.max(1, displayValue.toString().length)}
                value={displayValue}
                placeholder={placeholder}
                disabled={disabled}
                data-testid={dataTestId}
                className="number-input number-input-sides"
                onChange={handleInputChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
              />
              {suffix && (
                <span className="number-input-suffix-inline">{suffix}</span>
              )}
            </div>

            <button
              type="button"
              className="number-input-btn-side number-input-btn-right"
              onClick={increment}
              disabled={disabled || isAtMax}
              tabIndex={-1}
            >
              <Plus size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      );
    }

    // Default right layout: [value] [↑↓]
    return (
      <div className={wrapperClasses} style={style}>
        <div className="number-input-inner rounded-lg bg-bg-2">
          <input
            ref={ref}
            type="text"
            inputMode="decimal"
            value={displayValue}
            placeholder={placeholder}
            disabled={disabled}
            data-testid={dataTestId}
            className="number-input"
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />

          {suffix && <span className="number-input-suffix">{suffix}</span>}

          <div className="number-input-controls">
            <button
              type="button"
              className="number-input-btn number-input-btn-up"
              onClick={increment}
              disabled={disabled || isAtMax}
              tabIndex={-1}
            >
              <ChevronUp size={12} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="number-input-btn number-input-btn-down"
              onClick={decrement}
              disabled={disabled || isAtMin}
              tabIndex={-1}
            >
              <ChevronDown size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    );
  }
);

NumberInput.displayName = "NumberInput";

export default NumberInput;
