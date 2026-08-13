/**
 * Native Input Component
 *
 * Text input component with native implementation.
 *
 * Features:
 * - Full API compatibility
 * - Text, password, search variants
 * - Multiple sizes
 * - Prefix/suffix support
 * - Clear button
 * - Error states with optional single-line message
 *
 * @example
 * ```tsx
 * import Input from "@src/components/Input";
 *
 * <Input placeholder="Enter text" />
 * <Input type="password" size="large" />
 * <Input prefix={<Search size={16} />} />
 * <Input errorMessage="Name already exists" />
 * <Input errorMessage="Name already exists" errorPlacement="left" />
 * ```
 */
import { Eye, EyeOff, X } from "lucide-react";
import React, { forwardRef, useCallback, useState } from "react";

import type { FieldAppearance } from "@src/components/controlAppearance";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "size" | "prefix"
> {
  /**
   * Input value (controlled)
   */
  value?: string;

  /**
   * Default value (uncontrolled)
   */
  defaultValue?: string;

  /**
   * Change handler (receives string directly)
   */
  onChange?: (value: string, e: React.ChangeEvent<HTMLInputElement>) => void;

  /**
   * Input size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Input status/error state
   */
  error?: boolean;

  /**
   * Single-line error message rendered next to the input. When set, the input
   * is also styled as errored — no separate `error` flag needed.
   */
  errorMessage?: string;

  /**
   * Where the `errorMessage` sits relative to the input.
   * @default 'bottom'
   */
  errorPlacement?: "bottom" | "left";

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Readonly state
   */
  readOnly?: boolean;

  /**
   * Allow clear button
   */
  allowClear?: boolean;

  /**
   * Called when the clear button is clicked. When provided, the default
   * synthetic `onChange("")` is skipped so callers can fully own clear behavior
   * (e.g. reset related state in one place).
   */
  onClear?: () => void;

  /**
   * Prefix element (icon, text, etc.)
   */
  prefix?: React.ReactNode;

  /**
   * Suffix element (icon, text, etc.)
   */
  suffix?: React.ReactNode;

  /**
   * Max length
   */
  maxLength?: number;

  /**
   * Show word count
   */
  showWordLimit?: boolean;

  /**
   * Input type
   * @default 'text'
   */
  type?: "text" | "password" | "email" | "number" | "tel" | "url" | "search";

  /**
   * Show password visibility toggle (for password type)
   * @default true
   */
  visibilityToggle?: boolean;

  /**
   * Visual field treatment.
   *
   * `ghost` is transparent at rest and uses the shared interactive surface
   * while hovered or focused. `bare` stays permanently chromeless.
   * @default 'default'
   */
  appearance?: FieldAppearance;

  /**
   * Let content determine height instead of using the preset size height.
   */
  autoHeight?: boolean;

  /**
   * Additional class name for input element
   */
  inputClassName?: string;

  /**
   * Additional style for input element
   */
  inputStyle?: React.CSSProperties;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      value,
      defaultValue,
      onChange,
      size = "default",
      error = false,
      errorMessage,
      errorPlacement = "bottom",
      disabled = false,
      readOnly = false,
      allowClear = false,
      onClear,
      prefix,
      suffix,
      maxLength,
      showWordLimit = false,
      type = "text",
      visibilityToggle = true,
      appearance = "default",
      autoHeight = false,
      className = "",
      style,
      inputClassName = "",
      inputStyle,
      placeholder,
      onFocus,
      onBlur,
      onKeyDown,
      ...rest
    },
    ref
  ) => {
    const { isDark } = useCurrentTheme();
    const [internalValue, setInternalValue] = useState(defaultValue || "");
    const [isFocused, setIsFocused] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : internalValue;

    const hasError = error || !!errorMessage;
    const isChromeless = appearance !== "default";

    const wrapperClasses = [
      "input-wrapper",
      `input-size-${size}`,
      hasError && "input-error",
      disabled && "input-disabled",
      isFocused && "input-focused",
      readOnly && "input-readonly",
      appearance === "bare" && "input-field-bare",
      autoHeight && "input-auto-height",
      appearance === "ghost" && "input-field-ghost",
      isDark && "input-dark",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const inputClasses = ["input", inputClassName].filter(Boolean).join(" ");
    const inputInnerClassName = isChromeless
      ? "input-inner"
      : "input-inner rounded-lg bg-bg-2";

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;

        if (!isControlled) {
          setInternalValue(newValue);
        }

        onChange?.(newValue, e);
      },
      [isControlled, onChange]
    );

    const handleClear = useCallback(() => {
      if (onClear) {
        onClear();
        if (!isControlled) {
          setInternalValue("");
        }
        return;
      }

      const syntheticEvent = {
        target: { value: "" },
        currentTarget: { value: "" },
      } as React.ChangeEvent<HTMLInputElement>;

      if (!isControlled) {
        setInternalValue("");
      }

      onChange?.("", syntheticEvent);
    }, [isControlled, onChange, onClear]);

    const handleFocus = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        setIsFocused(true);
        onFocus?.(e);
      },
      [onFocus]
    );

    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        setIsFocused(false);
        onBlur?.(e);
      },
      [onBlur]
    );

    const tauriSelectAll = useTauriSelectAllShortcut();

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event);
        tauriSelectAll(event);
      },
      [onKeyDown, tauriSelectAll]
    );

    const togglePasswordVisibility = useCallback(() => {
      setShowPassword((prev) => !prev);
    }, []);

    const showClearButton =
      allowClear && currentValue && !disabled && !readOnly;
    const showPasswordToggle = type === "password" && visibilityToggle;
    const inputType =
      type === "password" ? (showPassword ? "text" : "password") : type;

    // For bottom placement the width style applies to the whole field so the
    // message wraps under a sized input. For left placement the style stays on
    // the input wrapper so the input keeps its width and the message is extra.
    const wrapperStyle =
      errorMessage && errorPlacement === "bottom" ? undefined : style;

    const inputWrapper = (
      <div className={wrapperClasses} style={wrapperStyle}>
        <div className={inputInnerClassName}>
          {prefix && <span className="input-prefix">{prefix}</span>}

          <input
            ref={ref}
            type={inputType}
            value={currentValue}
            disabled={disabled}
            readOnly={readOnly}
            placeholder={placeholder}
            maxLength={maxLength}
            className={inputClasses}
            style={inputStyle}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            {...rest}
          />

          {showClearButton && (
            <button
              type="button"
              className="input-clear"
              onClick={handleClear}
              tabIndex={-1}
            >
              <X size={16} />
            </button>
          )}

          {showPasswordToggle && (
            <button
              type="button"
              className="input-password-toggle"
              onClick={togglePasswordVisibility}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}

          {suffix && <span className="input-suffix">{suffix}</span>}

          {showWordLimit && maxLength && (
            <span className="input-word-limit">
              {currentValue?.length || 0}/{maxLength}
            </span>
          )}
        </div>
      </div>
    );

    if (!errorMessage) return inputWrapper;

    return (
      <div
        className={`input-field input-field-${errorPlacement}`}
        style={errorPlacement === "bottom" ? style : undefined}
      >
        {errorPlacement === "left" && (
          <span className="input-error-message">{errorMessage}</span>
        )}
        {inputWrapper}
        {errorPlacement === "bottom" && (
          <span className="input-error-message">{errorMessage}</span>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";

export default Input;
