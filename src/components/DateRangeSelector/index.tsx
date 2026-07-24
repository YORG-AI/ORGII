/**
 * DateRangeSelector Component
 *
 * A wrapper around DatePicker.RangePicker that provides a formatted string display
 * and raw date callbacks for integration with forms and modals.
 */
import dayjs from "dayjs";
import { Calendar } from "lucide-react";
import React, { useState } from "react";

import DatePicker from "@src/components/DatePicker";

import "./index.scss";

interface DateRangeSelectorProps {
  /**
   * Formatted date range string (e.g., "Start day - End day" or "Jan 5 – Jan 10, 2025")
   */
  dateRange?: string;

  /**
   * Callback when formatted date string changes
   */
  onDateChange?: (dateRange: string) => void;

  /**
   * Callback when raw Date objects change
   */
  onRawDateChange?: (dates: [Date | null, Date | null] | null) => void;

  /**
   * Whether to show time selection
   * @default false
   */
  showTime?: boolean;

  /**
   * Placeholder text
   * @default "Start day - End day"
   */
  placeholder?: string;

  /**
   * Additional class name
   */
  className?: string;
}

const DateRangeSelector: React.FC<DateRangeSelectorProps> = ({
  dateRange = "Start day - End day",
  onDateChange,
  onRawDateChange,
  showTime = false,
  placeholder = "Start day - End day",
  className = "",
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleDateChange = (dates: [Date | null, Date | null] | null) => {
    // Notify raw date change
    onRawDateChange?.(dates);

    // Format and notify string change
    if (dates && dates[0] && dates[1]) {
      const [start, end] = dates;
      let formattedRange: string;

      if (showTime) {
        // Format with time: "Jul 10, 14:30 – Jul 10, 2025 16:45"
        formattedRange = `${dayjs(start).format("MMM D, HH:mm")} – ${dayjs(end).format("MMM D, YYYY HH:mm")}`;
      } else {
        // Format without time: "Jul 10 – Jul 10, 2025"
        formattedRange = `${dayjs(start).format("MMM D")} – ${dayjs(end).format("MMM D, YYYY")}`;
      }

      onDateChange?.(formattedRange);
    } else {
      onDateChange?.(placeholder);
    }
  };

  // Parse dateRange string back to dates if needed for controlled component
  const parseDefaultValue = (): [Date | null, Date | null] | undefined => {
    if (!dateRange || dateRange === placeholder) {
      return undefined;
    }
    // For now, don't parse - let the component be uncontrolled
    return undefined;
  };

  const defaultClassName =
    "flex w-fit cursor-pointer items-center gap-1 rounded-lg border border-solid border-border-2 bg-bg-3 px-3 py-px text-sm text-text-2 transition-colors hover:bg-fill-2";

  return (
    <div className={`date-range-selector ${className}`}>
      <button
        type="button"
        className={`${defaultClassName}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        <Calendar className="text-sm text-text-2" size={14} />
        <span className="text-sm font-normal text-text-2">
          {dateRange || placeholder}
        </span>
      </button>

      {isOpen && (
        <div className="date-range-selector__picker">
          <DatePicker.RangePicker
            defaultValue={parseDefaultValue()}
            onChange={handleDateChange}
            placeholder={[
              placeholder.split(" - ")[0],
              placeholder.split(" - ")[1],
            ]}
          />
        </div>
      )}
    </div>
  );
};

export default DateRangeSelector;
