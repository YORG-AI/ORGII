/**
 * CalendarView Configuration
 *
 * Constants and utility functions for the CalendarView component.
 */
import {
  addLocalDays,
  addLocalMonths,
  formatLocalMonthDay,
  getStartOfLocalDay,
  isSameLocalDay,
} from "@src/util/data/formatters/date";
import { parseApiDate } from "@src/util/data/formatters/dateCore";

import type { CalendarViewMode } from "./types";

// ============================================
// View Mode Options
// ============================================

export const VIEW_MODE_OPTIONS: { value: CalendarViewMode; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

// ============================================
// Day/Week Names
// ============================================

export const WEEKDAY_NAMES_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

export const MONTH_NAMES_SHORT = [
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

// ============================================
// Date Utilities - Basic Operations
// ============================================

/** Parse date string or Date to Date object */
export function parseDate(date: Date | string): Date {
  if (date instanceof Date) return date;
  return parseApiDate(date) ?? new Date(Number.NaN);
}

/** Add days to a date */
export function addDays(date: Date, days: number): Date {
  return addLocalDays(date, days);
}

/** Add weeks to a date */
export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

/** Add months to a date */
export function addMonths(date: Date, months: number): Date {
  return addLocalMonths(date, months);
}

// ============================================
// Date Utilities - Start/End of Period
// ============================================

/** Get start of day (00:00:00.000) */
export function getStartOfDay(date: Date): Date {
  return getStartOfLocalDay(date);
}

/** Get end of day (23:59:59.999) */
export function getEndOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

/** Get start of week (weekStartsOn: 0 = Sunday, 1 = Monday) */
export function getStartOfWeek(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const dayOfWeek = result.getDay();
  const diff = (dayOfWeek - weekStartsOn + 7) % 7;
  result.setDate(result.getDate() - diff);
  return result;
}

/** Get end of week */
export function getEndOfWeek(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  const startOfWeek = getStartOfWeek(date, weekStartsOn);
  const result = addDays(startOfWeek, 6);
  result.setHours(23, 59, 59, 999);
  return result;
}

/** Get start of month */
export function getStartOfMonth(date: Date): Date {
  const result = new Date(date);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

/** Get end of month */
export function getEndOfMonth(date: Date): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1, 0);
  result.setHours(23, 59, 59, 999);
  return result;
}

// ============================================
// Date Utilities - Comparisons
// ============================================

/** Check if two dates are the same day */
export function isSameDay(date1: Date, date2: Date): boolean {
  return isSameLocalDay(date1, date2);
}

/** Check if a date is today */
export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

/** Check if a date is a weekend (Saturday or Sunday) */
export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** Check if two dates are in the same month */
export function isSameMonth(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth()
  );
}

// ============================================
// Date Utilities - Formatting
// ============================================

/** Format month and year (e.g., "Jan 2026") */
export function formatMonthYear(date: Date): string {
  return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** Format time (e.g., "09:00" or "9 AM") */
export function formatTime(hour: number, use24Hour: boolean = true): string {
  if (use24Hour) {
    return `${hour.toString().padStart(2, "0")}:00`;
  }
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour} ${period}`;
}

/** Format date for display (e.g., "Jan 5" or "Jan 5, 2026") */
export function formatDate(date: Date, includeYear: boolean = false): string {
  return formatLocalMonthDay(date, { includeYear });
}

// ============================================
// Calendar Grid Utilities
// ============================================

/**
 * Get all days to display in a month calendar grid.
 * Returns 35-42 days including padding from adjacent months.
 */
export function getMonthCalendarDays(
  date: Date,
  weekStartsOn: 0 | 1 = 1
): Date[] {
  const days: Date[] = [];
  const monthStart = getStartOfMonth(date);
  const monthEnd = getEndOfMonth(date);

  // Start from the beginning of the week that contains the first day
  const calendarStart = getStartOfWeek(monthStart, weekStartsOn);

  // End at the end of the week that contains the last day
  const calendarEnd = getEndOfWeek(monthEnd, weekStartsOn);

  let current = new Date(calendarStart);
  while (current <= calendarEnd) {
    days.push(new Date(current));
    current = addDays(current, 1);
  }

  return days;
}

/** Get days for a week view (7 days starting from week start) */
export function getWeekDays(date: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const days: Date[] = [];
  const weekStart = getStartOfWeek(date, weekStartsOn);

  for (let index = 0; index < 7; index++) {
    days.push(addDays(weekStart, index));
  }

  return days;
}

/** Generate time slots for day/week view */
export function getTimeSlots(
  startHour: number,
  endHour: number,
  slotMinutes: number = 60
): string[] {
  const slots: string[] = [];
  const totalMinutes = (endHour - startHour) * 60;
  const numSlots = Math.ceil(totalMinutes / slotMinutes);

  for (let index = 0; index < numSlots; index++) {
    const totalMins = startHour * 60 + index * slotMinutes;
    const hour = Math.floor(totalMins / 60);
    const minute = totalMins % 60;
    slots.push(
      `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
    );
  }

  return slots;
}

// ============================================
// Event Utilities
// ============================================

/** Check if an event spans a specific date */
export function eventSpansDate(
  eventStart: Date,
  eventEnd: Date,
  date: Date
): boolean {
  const dayStart = getStartOfDay(date);
  const dayEnd = getEndOfDay(date);
  return eventStart <= dayEnd && eventEnd >= dayStart;
}

/** Calculate event position as percentage of day (for day/week views) */
export function getEventTimePosition(
  eventTime: Date,
  dayStartHour: number,
  dayEndHour: number
): number {
  const eventMinutes = eventTime.getHours() * 60 + eventTime.getMinutes();
  const startMinutes = dayStartHour * 60;
  const totalMinutes = (dayEndHour - dayStartHour) * 60;

  const position = ((eventMinutes - startMinutes) / totalMinutes) * 100;
  return Math.max(0, Math.min(100, position));
}
