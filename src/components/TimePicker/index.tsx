import React, { useCallback } from "react";

import type { ControlAppearance } from "@src/components/controlAppearance";

export interface TimePickerProps {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  minuteStep?: number;
  disabled?: boolean;
  className?: string;
  appearance?: ControlAppearance;
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const [hourPart, minutePart] = value.split(":");
  const parsedHour = Number(hourPart);
  const parsedMinute = Number(minutePart);

  if (
    !Number.isInteger(parsedHour) ||
    !Number.isInteger(parsedMinute) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }

  return { hour: parsedHour, minute: parsedMinute };
}

const TimePicker: React.FC<TimePickerProps> = ({
  hour,
  minute,
  onChange,
  minuteStep = 5,
  disabled = false,
  className = "",
  appearance = "default",
}) => {
  const handleTimeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const parsed = parseTime(event.target.value);
      if (!parsed) return;
      onChange(parsed.hour, parsed.minute);
    },
    [onChange]
  );

  const inputClassName = [
    "h-7 rounded-lg px-2 text-[13px] text-text-1 outline-none transition-colors",
    "[color-scheme:light_dark]",
    appearance === "ghost"
      ? "border border-transparent bg-transparent hover:bg-surface-hover focus:bg-surface-hover"
      : "border border-border-2 bg-bg-2 focus:border-primary-6 focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]",
    disabled && "cursor-not-allowed opacity-50",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <input
      type="time"
      value={formatTime(hour, minute)}
      onChange={handleTimeChange}
      disabled={disabled}
      step={minuteStep * 60}
      className={`${inputClassName} ${className}`}
    />
  );
};

export default TimePicker;
