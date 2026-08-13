/**
 * DatePicker Component
 *
 * Date selection component with calendar popup.
 *
 *
 * Features:
 * - Date selection
 * - Date range selection
 * - Custom format
 * - Disabled dates
 * - Placeholder support
 *
 * @example
 * ```tsx
 * import DatePicker from "@src/components/DatePicker";
 *
 * // Basic date picker
 * <DatePicker
 *   value={date}
 *   onChange={(date) => setDate(date)}
 * />
 *
 * // Date range picker
 * <DatePicker.RangePicker
 *   value={[startDate, endDate]}
 *   onChange={([start, end]) => {
 *     setStartDate(start);
 *     setEndDate(end);
 *   }}
 * />
 * ```
 */
import { Calendar, X } from "lucide-react";
import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ControlAppearance } from "@src/components/controlAppearance";

import "./index.scss";

export interface DatePickerProps {
  /**
   * Selected date value
   */
  value?: Date | null;

  /**
   * Default value
   */
  defaultValue?: Date | null;

  /**
   * Placeholder text
   * @default 'Select date'
   */
  placeholder?: string;

  /**
   * Date format
   * @default 'YYYY-MM-DD'
   */
  format?: string;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Allow clear
   * @default true
   */
  allowClear?: boolean;

  /**
   * Size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Visual appearance
   * @default 'default'
   */
  appearance?: ControlAppearance;

  /**
   * Change callback
   */
  onChange?: (date: Date | null) => void;

  /**
   * Min date (YYYY-MM-DD) — disables dates before this
   */
  min?: string;

  /**
   * Max date (YYYY-MM-DD) — disables dates after this
   */
  max?: string;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;
}

export interface RangePickerProps {
  /**
   * Selected date range
   */
  value?: [Date | null, Date | null];

  /**
   * Default value
   */
  defaultValue?: [Date | null, Date | null];

  /**
   * Placeholder text
   * @default ['Start date', 'End date']
   */
  placeholder?: [string, string];

  /**
   * Date format
   * @default 'YYYY-MM-DD'
   */
  format?: string;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Allow clear
   * @default true
   */
  allowClear?: boolean;

  /**
   * Size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Change callback
   */
  onChange?: (dates: [Date | null, Date | null]) => void;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;
}

// Format date to string
function formatDate(date: Date | null, format: string = "YYYY-MM-DD"): string {
  if (!date) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return format
    .replace("YYYY", String(year))
    .replace("MM", month)
    .replace("DD", day);
}

// DatePicker Component
const DatePicker: React.FC<DatePickerProps> & {
  RangePicker: React.FC<RangePickerProps>;
} = ({
  value: controlledValue,
  defaultValue,
  placeholder: placeholderProp,
  format: _format = "YYYY-MM-DD",
  disabled = false,
  allowClear = true,
  size = "default",
  appearance = "default",
  onChange,
  min,
  max,
  className = "",
  style,
}) => {
  const { t } = useTranslation();
  const placeholder = placeholderProp ?? t("labels.selectDate");
  const [internalValue, setInternalValue] = useState<Date | null>(
    defaultValue || null
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dateStr = e.target.value;
    const newDate = dateStr ? new Date(dateStr) : null;

    if (controlledValue === undefined) {
      setInternalValue(newDate);
    }
    onChange?.(newDate);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (controlledValue === undefined) {
      setInternalValue(null);
    }
    onChange?.(null);
  };

  const pickerClasses = [
    "datepicker",
    `datepicker-${size}`,
    appearance === "ghost" && "datepicker-ghost",
    disabled && "datepicker-disabled",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={pickerClasses} style={style}>
      <Calendar size={16} className="datepicker-icon" />
      <input
        ref={inputRef}
        type="date"
        value={value ? formatDate(value, "YYYY-MM-DD") : ""}
        placeholder={placeholder}
        disabled={disabled}
        min={min}
        max={max}
        onChange={handleChange}
        className="datepicker-input"
      />
      {allowClear && value && !disabled && (
        <X
          size={14}
          className="datepicker-clear cursor-pointer"
          onClick={handleClear}
        />
      )}
    </div>
  );
};

// RangePicker Component
const RangePicker: React.FC<RangePickerProps> = ({
  value: controlledValue,
  defaultValue,
  placeholder: placeholderProp,
  format: _format = "YYYY-MM-DD",
  disabled = false,
  allowClear = true,
  size = "default",
  onChange,
  className = "",
  style,
}) => {
  const { t } = useTranslation();
  const placeholder = placeholderProp ?? [
    t("devRecord.startDate"),
    t("devRecord.endDate"),
  ];
  const [internalValue, setInternalValue] = useState<
    [Date | null, Date | null]
  >(defaultValue || [null, null]);

  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dateStr = e.target.value;
    const newDate = dateStr ? new Date(dateStr) : null;
    const newValue: [Date | null, Date | null] = [newDate, value[1]];

    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dateStr = e.target.value;
    const newDate = dateStr ? new Date(dateStr) : null;
    const newValue: [Date | null, Date | null] = [value[0], newDate];

    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newValue: [Date | null, Date | null] = [null, null];
    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  const pickerClasses = [
    "datepicker",
    "datepicker-range",
    `datepicker-${size}`,
    disabled && "datepicker-disabled",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const hasValue = value[0] || value[1];

  return (
    <div className={pickerClasses} style={style}>
      <Calendar size={16} className="datepicker-icon" />
      <input
        type="date"
        value={value[0] ? formatDate(value[0], "YYYY-MM-DD") : ""}
        placeholder={placeholder[0]}
        disabled={disabled}
        onChange={handleStartChange}
        className="datepicker-input"
      />
      <span className="datepicker-separator">–</span>
      <input
        type="date"
        value={value[1] ? formatDate(value[1], "YYYY-MM-DD") : ""}
        placeholder={placeholder[1]}
        disabled={disabled}
        onChange={handleEndChange}
        className="datepicker-input"
      />
      {allowClear && hasValue && !disabled && (
        <X
          size={14}
          className="datepicker-clear cursor-pointer"
          onClick={handleClear}
        />
      )}
    </div>
  );
};

DatePicker.RangePicker = RangePicker;

export default DatePicker;
