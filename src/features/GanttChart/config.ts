/**
 * GanttChart Configuration
 *
 * Constants and utility functions for the GanttChart component.
 */
import {
  type GanttTimeScale,
  type GanttViewScope,
  VIEW_SCOPE_CONFIGS,
} from "./types";

// ============================================
// View Scope Options (new model)
// ============================================

export const VIEW_SCOPE_OPTIONS: { value: GanttViewScope; label: string }[] = [
  { value: "3d", label: "3d" },
  { value: "7d", label: "7d" },
  { value: "1m", label: "1m" },
  { value: "3m", label: "3m" },
];

// TimeScale → ViewScope mapping

// Map legacy time scales to new view scopes

// ============================================
// Date Utilities
// ============================================

/**
 * Get the start of a period based on time scale
 */
export function getStartOfPeriod(date: Date, scale: GanttTimeScale): Date {
  const result = new Date(date);

  switch (scale) {
    case "day":
      result.setHours(0, 0, 0, 0);
      break;
    case "week": {
      result.setHours(0, 0, 0, 0);
      // Move to Monday
      const dayOfWeek = result.getDay();
      const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      result.setDate(result.getDate() + diff);
      break;
    }
    case "month":
      result.setDate(1);
      result.setHours(0, 0, 0, 0);
      break;
    case "quarter": {
      const quarterMonth = Math.floor(result.getMonth() / 3) * 3;
      result.setMonth(quarterMonth, 1);
      result.setHours(0, 0, 0, 0);
      break;
    }
  }

  return result;
}

// ============================================
// View Scope Period Generation
// ============================================

export interface ViewScopePeriod {
  date: Date;
  label: string;
  isAM?: boolean; // For halfday unit
  dayOfWeek?: number; // 0-6
  isToday?: boolean;
  isWeekend?: boolean;
}

const MONTH_NAMES = [
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

/**
 * Generate periods for a given view scope centered around a date.
 * Generates periods both before and after the center date for bidirectional scrolling.
 *
 * @param centerDate - The center date for period generation (usually viewStart)
 * @param viewScope - The view scope (1d, 3d, 7d, 1m, 3m)
 * @param scrollMultiplier - How many "screens" worth of data to generate in each direction (default: 5)
 */
export function generateViewScopePeriods(
  centerDate: Date,
  viewScope: GanttViewScope,
  scrollMultiplier: number = 5
): ViewScopePeriod[] {
  const config = VIEW_SCOPE_CONFIGS[viewScope];
  const periods: ViewScopePeriod[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const center = new Date(centerDate);
  center.setHours(0, 0, 0, 0);

  // Calculate periods to generate in each direction
  // Generate scrollMultiplier screens before + current screen + scrollMultiplier screens after
  const columnsPerDirection = config.columns * scrollMultiplier;

  switch (viewScope) {
    case "1d": {
      const totalHours = columnsPerDirection * 2 + config.columns;
      const startOffset = -columnsPerDirection;

      for (let hourIndex = 0; hourIndex < totalHours; hourIndex++) {
        const currentDate = new Date(center);
        currentDate.setHours(startOffset + hourIndex, 0, 0, 0);
        const dayOfWeek = currentDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isTodayDate =
          currentDate.getFullYear() === today.getFullYear() &&
          currentDate.getMonth() === today.getMonth() &&
          currentDate.getDate() === today.getDate();
        const hour = currentDate.getHours();

        periods.push({
          date: currentDate,
          label: `${String(hour).padStart(2, "0")}:00`,
          dayOfWeek,
          isToday: isTodayDate,
          isWeekend,
        });
      }
      break;
    }

    case "3d": {
      // Each column = half day (AM/PM)
      const daysPerDirection = Math.ceil(columnsPerDirection / 2);
      const totalDays = daysPerDirection * 2 + Math.ceil(config.columns / 2);
      const startOffset = -daysPerDirection;

      for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
        const currentDate = new Date(center);
        currentDate.setDate(center.getDate() + startOffset + dayIndex);
        const dayOfWeek = currentDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isTodayDate = currentDate.getTime() === today.getTime();

        // AM
        const amDate = new Date(currentDate);
        amDate.setHours(0, 0, 0, 0);
        periods.push({
          date: amDate,
          label: `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getDate()} AM`,
          isAM: true,
          dayOfWeek,
          isToday: isTodayDate,
          isWeekend,
        });

        // PM
        const pmDate = new Date(currentDate);
        pmDate.setHours(12, 0, 0, 0);
        periods.push({
          date: pmDate,
          label: `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getDate()} PM`,
          isAM: false,
          dayOfWeek,
          isToday: isTodayDate,
          isWeekend,
        });
      }
      break;
    }

    case "7d": {
      // Each column = 1 day
      const totalDays = columnsPerDirection * 2 + config.columns;
      const startOffset = -columnsPerDirection;

      for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
        const currentDate = new Date(center);
        currentDate.setDate(center.getDate() + startOffset + dayIndex);
        const dayOfWeek = currentDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isTodayDate = currentDate.getTime() === today.getTime();

        periods.push({
          date: currentDate,
          label: `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getDate()}`,
          dayOfWeek,
          isToday: isTodayDate,
          isWeekend,
        });
      }
      break;
    }

    case "1m": {
      // Each column = 1 day
      const totalDays = columnsPerDirection * 2 + config.columns;
      const startOffset = -columnsPerDirection;

      for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
        const currentDate = new Date(center);
        currentDate.setDate(center.getDate() + startOffset + dayIndex);
        const dayOfWeek = currentDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isTodayDate = currentDate.getTime() === today.getTime();

        periods.push({
          date: currentDate,
          label: `${currentDate.getDate()}`,
          dayOfWeek,
          isToday: isTodayDate,
          isWeekend,
        });
      }
      break;
    }

    case "3m": {
      // Each column = 1 week
      const totalWeeks = columnsPerDirection * 2 + config.columns;
      const startOffset = -columnsPerDirection;

      for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex++) {
        const currentDate = new Date(center);
        currentDate.setDate(center.getDate() + (startOffset + weekIndex) * 7);
        const dayOfWeek = currentDate.getDay();
        const isTodayInWeek =
          today >= currentDate &&
          today < new Date(currentDate.getTime() + 7 * 24 * 60 * 60 * 1000);

        periods.push({
          date: currentDate,
          label: `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getDate()}`,
          dayOfWeek,
          isToday: isTodayInWeek,
          isWeekend: false,
        });
      }
      break;
    }
  }

  return periods;
}

/**
 * Get the secondary header label (grouping label) for view scope
 */
export function getViewScopeSecondaryLabel(
  date: Date,
  viewScope: GanttViewScope
): string {
  const month = MONTH_NAMES[date.getMonth()];
  const year = date.getFullYear();

  switch (viewScope) {
    case "1d":
      return `${month} ${date.getDate()}, ${year}`;
    case "3d":
    case "7d":
      return `${month} ${year}`;
    case "1m":
      return `${month} ${year}`;
    case "3m":
      return `${year}`;
  }
}

/**
 * Calculate the number of milliseconds per column for a view scope
 */
export function getMsPerColumn(viewScope: GanttViewScope): number {
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  switch (viewScope) {
    case "1d":
      return MS_PER_HOUR;
    case "3d":
      return 12 * MS_PER_HOUR; // Half day
    case "7d":
    case "1m":
      return MS_PER_DAY; // Full day
    case "3m":
      return 7 * MS_PER_DAY; // Week
  }
}

/**
 * Check if a date is today
 */
export function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}
