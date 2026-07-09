/**
 * DateRangePills — Filter-sidebar pill grid for preset date ranges.
 *
 * Renders a 3-column grid of preset pills (excluding "custom") followed by a
 * "Custom" pill. When "custom" is active and `onCustomDatesChange` is provided,
 * a DatePicker.RangePicker is shown below the grid.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import DatePicker from "@src/components/DatePicker";

import { DATE_RANGE_OPTIONS } from "../views/CodingProfileView/config";
import type { ProfileDateRange } from "../views/CodingProfileView/config";

const RANGE_PILL_BASE =
  "flex items-center justify-center rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors cursor-pointer";
const RANGE_PILL_ACTIVE = `${RANGE_PILL_BASE} bg-fill-2 text-text-1`;
const RANGE_PILL_INACTIVE = `${RANGE_PILL_BASE} text-text-3 hover:bg-fill-2 hover:text-text-2`;

interface DateRangePillsProps {
  value: ProfileDateRange;
  onChange: (range: ProfileDateRange) => void;
  customStartDate?: string;
  customEndDate?: string;
  onCustomDatesChange?: (startDate: string, endDate: string) => void;
}

const DateRangePills: React.FC<DateRangePillsProps> = ({
  value,
  onChange,
  customStartDate,
  customEndDate,
  onCustomDatesChange,
}) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {DATE_RANGE_OPTIONS.filter((opt) => opt.key !== "custom").map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={
              value === opt.key ? RANGE_PILL_ACTIVE : RANGE_PILL_INACTIVE
            }
            onClick={() => onChange(opt.key as ProfileDateRange)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          className={
            value === "custom" ? RANGE_PILL_ACTIVE : RANGE_PILL_INACTIVE
          }
          onClick={() => onChange("custom")}
        >
          {t("common:filters.custom")}
        </button>
      </div>

      {value === "custom" && onCustomDatesChange && (
        <div className="mt-2">
          <DatePicker.RangePicker
            value={[
              customStartDate ? new Date(customStartDate) : null,
              customEndDate ? new Date(customEndDate) : null,
            ]}
            onChange={(dates) => {
              if (dates) {
                const start = dates[0]
                  ? dates[0].toISOString().slice(0, 10)
                  : "";
                const end = dates[1] ? dates[1].toISOString().slice(0, 10) : "";
                onCustomDatesChange(start, end);
              }
            }}
            size="small"
          />
        </div>
      )}
    </>
  );
};

export default DateRangePills;
