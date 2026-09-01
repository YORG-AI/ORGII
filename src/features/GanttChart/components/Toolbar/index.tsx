/**
 * GanttToolbar Component
 *
 * Toolbar with view scope toggle and navigation controls.
 * Layout: [Scale Toggle] ... [Zoom] < [Date Range] > [Today]
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import TabPill from "@src/components/TabPill";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@src/icons";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";

import { VIEW_SCOPE_OPTIONS } from "../../config";
import type { ZoomLevel } from "../../hooks/useGanttZoom";
import type { GanttTimeScale, GanttViewScope } from "../../types";

// ============================================
// Types
// ============================================

interface GanttToolbarProps {
  /** @deprecated Use viewScope instead */
  timeScale?: GanttTimeScale;
  /** Current view scope (3d, 7d, 1m, 3m) */
  viewScope: GanttViewScope;
  /** @deprecated Use onViewScopeChange instead */
  onTimeScaleChange?: (scale: GanttTimeScale) => void;
  /** Callback when view scope changes */
  onViewScopeChange: (scope: GanttViewScope) => void;
  onNavigate: (direction: "prev" | "next") => void;
  onGoToToday: () => void;
  /** Current date being viewed */
  currentDate?: Date;
  zoomLevel?: ZoomLevel;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
}

// ============================================
// Helpers
// ============================================

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Format date range based on view scope */
function formatDateRange(date: Date, viewScope: GanttViewScope): string {
  switch (viewScope) {
    case "1d":
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}`;
    case "3d": {
      // "Jan 5-7"
      const endDate = addDays(date, 2);
      if (date.getMonth() === endDate.getMonth()) {
        return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}-${endDate.getDate()}`;
      }
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()} - ${MONTH_NAMES_SHORT[endDate.getMonth()]} ${endDate.getDate()}`;
    }
    case "7d": {
      // "Jan 1-7"
      const endDate = addDays(date, 6);
      if (date.getMonth() === endDate.getMonth()) {
        return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}-${endDate.getDate()}`;
      }
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()} - ${MONTH_NAMES_SHORT[endDate.getMonth()]} ${endDate.getDate()}`;
    }
    case "1m":
      // "Jan 2026"
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getFullYear()}`;
    case "3m": {
      // "Jan-Mar 2026"
      const endMonth = (date.getMonth() + 2) % 12;
      return `${MONTH_NAMES_SHORT[date.getMonth()]}-${MONTH_NAMES_SHORT[endMonth]} ${date.getFullYear()}`;
    }
    default:
      return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getFullYear()}`;
  }
}

// ============================================
// Component
// ============================================

const GanttToolbar: React.FC<GanttToolbarProps> = ({
  viewScope,
  onViewScopeChange,
  onNavigate,
  onGoToToday,
  currentDate,
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onResetZoom,
}) => {
  const { t } = useTranslation();
  const handleViewScopeToggle = (label: string) => {
    const option = VIEW_SCOPE_OPTIONS.find((opt) => opt.label === label);
    if (option) {
      onViewScopeChange(option.value);
    }
  };

  const currentLabel =
    VIEW_SCOPE_OPTIONS.find((option) => option.value === viewScope)?.label ||
    "7d";

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-2 bg-bg-2 px-4">
      {/* Left: View scope toggle */}
      <div className="flex items-center gap-3">
        <TabPill
          tabs={VIEW_SCOPE_OPTIONS.map((option) => option.label)}
          activeTab={currentLabel}
          onChange={handleViewScopeToggle}
          variant="pill"
        />
      </div>

      {/* Right: Zoom + < Date Range > Today */}
      <div className="flex items-center gap-1">
        {/* Zoom controls */}
        {zoomLevel !== undefined && onZoomIn && onZoomOut && onResetZoom && (
          <div className="flex items-center gap-1">
            <Button
              {...PANEL_HEADER_TOKENS.actionButton}
              icon={
                <HugeiconsIcon
                  icon={ZoomOutAreaIcon}
                  data-icon="zoom-out"
                  size={PANEL_HEADER_TOKENS.buttonIconSize}
                  strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                />
              }
              onClick={onZoomOut}
              disabled={zoomLevel === 50}
              title={t("tooltips.zoomOut")}
            />
            <button
              type="button"
              className="min-w-12 cursor-pointer rounded border-none bg-fill-1 px-2 py-1 text-[11px] font-medium text-text-2 transition-all duration-150 hover:bg-fill-2 hover:text-text-1"
              onClick={onResetZoom}
              title={t("tooltips.resetZoom")}
            >
              {zoomLevel}%
            </button>
            <Button
              {...PANEL_HEADER_TOKENS.actionButton}
              icon={
                <HugeiconsIcon
                  icon={ZoomInAreaIcon}
                  data-icon="zoom-in"
                  size={PANEL_HEADER_TOKENS.buttonIconSize}
                  strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                />
              }
              onClick={onZoomIn}
              disabled={zoomLevel === 200}
              title={t("tooltips.zoomIn")}
            />
            <div className="mx-1 h-5 w-px bg-border-2" />
          </div>
        )}

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
          onClick={() => onNavigate("prev")}
          title={t("tooltips.previous")}
        />

        {/* Date Range */}
        {currentDate && (
          <span className="min-w-[100px] text-center text-sm font-medium text-text-1">
            {formatDateRange(currentDate, viewScope)}
          </span>
        )}

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
          onClick={() => onNavigate("next")}
          title={t("tooltips.next")}
        />

        {/* Today */}
        <button
          type="button"
          className="ml-1 cursor-pointer rounded-md border-none bg-fill-1 px-3 py-1 text-xs text-text-2 transition-all duration-150 hover:bg-fill-2 hover:text-text-1"
          onClick={onGoToToday}
          title={t("tooltips.goToToday")}
        >
          Today
        </button>
      </div>
    </div>
  );
};

export default GanttToolbar;
