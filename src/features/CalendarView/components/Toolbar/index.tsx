/**
 * CalendarToolbar Component
 *
 * Toolbar with Day/Week/Month toggle and navigation controls.
 * Layout: [Scale Toggle] ... < [Date Range] > [Today]
 */
import React from "react";

import Button from "@src/components/Button";
import TabPill from "@src/components/TabPill";
import { ArrowLeft01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";

import {
  MONTH_NAMES_SHORT,
  VIEW_MODE_OPTIONS,
  addDays,
  formatMonthYear,
} from "../../config";
import type { CalendarViewMode } from "../../types";

// ============================================
// Types
// ============================================

export interface CalendarToolbarProps {
  /** Current view mode */
  viewMode: CalendarViewMode;
  /** Callback when view mode changes */
  onViewModeChange: (mode: CalendarViewMode) => void;
  /** Current date being displayed */
  currentDate: Date;
  /** Navigate to previous period */
  onNavigatePrev: () => void;
  /** Navigate to next period */
  onNavigateNext: () => void;
  /** Navigate to today */
  onGoToToday: () => void;
}

// ============================================
// Helpers
// ============================================

/** Format date range based on view mode */
function formatDateRange(date: Date, viewMode: CalendarViewMode): string {
  switch (viewMode) {
    case "day":
      // "Jan 5"
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}`;
    case "week": {
      // "Jan 1-7" or "Dec 29 - Jan 4"
      const weekEnd = addDays(date, 6);
      if (date.getMonth() === weekEnd.getMonth()) {
        return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}-${weekEnd.getDate()}`;
      }
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()} - ${MONTH_NAMES_SHORT[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
    }
    case "month":
    default:
      // "Jan 2026"
      return formatMonthYear(date);
  }
}

// ============================================
// Component
// ============================================

const CalendarToolbar: React.FC<CalendarToolbarProps> = ({
  viewMode,
  onViewModeChange,
  currentDate,
  onNavigatePrev,
  onNavigateNext,
  onGoToToday,
}) => {
  const handleViewModeToggle = (label: string) => {
    const option = VIEW_MODE_OPTIONS.find((opt) => opt.label === label);
    if (option) {
      onViewModeChange(option.value);
    }
  };

  const currentLabel =
    VIEW_MODE_OPTIONS.find((opt) => opt.value === viewMode)?.label || "Month";

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-2 px-4">
      {/* Left: View mode toggle */}
      <div className="flex items-center gap-3">
        <TabPill
          tabs={VIEW_MODE_OPTIONS.map((opt) => opt.label)}
          activeTab={currentLabel}
          onChange={handleViewModeToggle}
          variant="pill"
        />
      </div>

      {/* Right: < [Date Range] > Today */}
      <div className="flex items-center gap-1">
        {/* Previous */}
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              data-icon="chevron-left"
              size={PANEL_HEADER_TOKENS.buttonIconSize}
              strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
            />
          }
          onClick={onNavigatePrev}
          title="Previous"
        />

        {/* Date Range */}
        <span className="min-w-[100px] text-center text-sm font-medium text-text-1">
          {formatDateRange(currentDate, viewMode)}
        </span>

        {/* Next */}
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={PANEL_HEADER_TOKENS.buttonIconSize}
              strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
            />
          }
          onClick={onNavigateNext}
          title="Next"
        />

        {/* Today */}
        <button
          type="button"
          className="ml-1 cursor-pointer rounded-md border-none bg-fill-1 px-3 py-1 text-xs text-text-2 transition-all duration-150 hover:bg-fill-2 hover:text-text-1"
          onClick={onGoToToday}
          title="Go to today"
        >
          Today
        </button>
      </div>
    </div>
  );
};

export default CalendarToolbar;
