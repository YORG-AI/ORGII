/**
 * InlineNumberInput Component
 *
 * A minimal inline number input that blends into natural language sentences.
 * Shows as highlighted text, expands to input field when clicked.
 *
 * @example
 * Wait for <InlineNumberInput value={5} onChange={...} /> seconds
 */
import cn from "classnames";
import React, { useCallback, useEffect, useRef, useState } from "react";

// ============================================
// Types
// ============================================

export interface InlineNumberInputProps {
  value?: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  unitPlural?: string; // Optional plural form, defaults to unit + 's'
  className?: string;
  placeholder?: string;
  /** Background color variant for hover/active states */
  bgVariant?: "fill-2" | "bg-2";
}

// ============================================
// Component
// ============================================

const InlineNumberInput: React.FC<InlineNumberInputProps> = ({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  unit,
  unitPlural,
  className = "",
  placeholder = "0",
  bgVariant = "bg-2",
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  // Use prop value when not editing, internal state when editing
  const displayValue = isEditing ? inputValue : String(value ?? "");

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleClick = useCallback(() => {
    setInputValue(String(value ?? ""));
    setIsEditing(true);
  }, [value]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    const parsed = parseFloat(inputValue);
    if (!isNaN(parsed)) {
      let finalValue = parsed;
      if (min !== undefined && finalValue < min) finalValue = min;
      if (max !== undefined && finalValue > max) finalValue = max;
      onChange(finalValue);
      setInputValue(String(finalValue));
    } else {
      // Reset to previous value
      setInputValue(String(value ?? ""));
    }
  }, [inputValue, min, max, onChange, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        inputRef.current?.blur();
      } else if (event.key === "Escape") {
        setInputValue(String(value ?? ""));
        setIsEditing(false);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const current = parseFloat(inputValue) || 0;
        const newValue =
          max !== undefined ? Math.min(current + step, max) : current + step;
        setInputValue(String(newValue));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const current = parseFloat(inputValue) || 0;
        const newValue =
          min !== undefined ? Math.max(current - step, min) : current - step;
        setInputValue(String(newValue));
      }
    },
    [inputValue, value, min, max, step]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(event.target.value);
    },
    []
  );

  // Calculate input width based on content
  const inputWidth = Math.max(
    40,
    (displayValue.length || placeholder.length) * 10 + 24
  );

  // Determine if we should use plural form
  const displayUnit = unit
    ? value === 1
      ? unit
      : unitPlural || (unit.endsWith("s") ? unit : `${unit}s`)
    : undefined;

  const hoverBgClass =
    bgVariant === "bg-2" ? "hover:bg-bg-2" : "hover:bg-fill-2";
  const activeBgClass = bgVariant === "bg-2" ? "bg-bg-2" : "bg-fill-2";

  return (
    <span
      ref={containerRef}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="number"
          value={displayValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          className={cn(
            "h-[24px] rounded-full px-2 text-center text-primary-6 outline-none transition-all duration-200",
            activeBgClass,
            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          )}
          style={{ width: inputWidth }}
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(event) => event.key === "Enter" && handleClick()}
          className={cn(
            "inline-flex h-[24px] shrink-0 cursor-pointer items-center rounded-full px-2 text-[14px] font-medium text-primary-6 transition-all duration-200 focus:outline-none",
            hoverBgClass
          )}
        >
          {displayValue || placeholder}
        </span>
      )}
      {displayUnit && <span className="text-text-1">{displayUnit}</span>}
    </span>
  );
};

export default InlineNumberInput;
