/**
 * Date Utilities with Timezone Support
 *
 * This module provides timezone-aware date parsing and formatting functions.
 * The API typically returns UTC timestamps without timezone indicators,
 * so we need to handle them properly based on user preferences.
 *
 * Consolidated from:
 * - dateUtils.ts (original)
 * - formatTimeStamp.ts (merged)
 * - timeCount.ts (merged)
 * - dayjsAdaptArea.ts (merged)
 */
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches workstation/codeEditor modules and creates a circular dependency.
import {
  getCurrentTimezone,
  resolveTimeZoneForIntl,
} from "@src/config/timezone";

import { parseApiDate } from "./dateCore";

export { parseApiDate };

/**
 * Format a date for display in the user's preferred timezone.
 *
 * @param dateString - The date string from the API (assumed UTC if no timezone)
 * @param options - Intl.DateTimeFormat options
 * @param locale - BCP 47 locale used for the rendered date
 * @returns A formatted date string in the user's timezone
 */
export const formatDate = (
  dateString: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale = "en-US"
): string => {
  if (!dateString) return "—";

  try {
    const date = parseApiDate(dateString);
    if (!date) return "—";

    const timezone = getCurrentTimezone();
    const defaultOptions: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };

    const formatOptions = { ...defaultOptions, ...options };

    // Apply timezone if not "auto"
    if (timezone !== "auto") {
      formatOptions.timeZone = timezone === "utc" ? "UTC" : timezone;
    }

    return date.toLocaleString(locale, formatOptions);
  } catch {
    return "—";
  }
};

/**
 * Format a date to show only the time (HH:MM format)
 *
 * @param dateString - The date string from the API (assumed UTC if no timezone)
 * @returns A formatted time string
 */
export const formatTime = (dateString: string | null | undefined): string => {
  if (!dateString) return "—";

  try {
    const date = parseApiDate(dateString);
    if (!date) return "—";

    const timezone = getCurrentTimezone();
    const options: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };

    if (timezone !== "auto") {
      options.timeZone = timezone === "utc" ? "UTC" : timezone;
    }

    return date.toLocaleTimeString("en-US", options);
  } catch {
    return "—";
  }
};

/**
 * Map app language codes to BCP-47 locale tags for {@link Intl} (month names, time).
 */
export function toIntlLocaleTag(language: string | undefined): string {
  if (!language) return "en-US";
  if (language === "en") return "en-US";
  if (language === "zh") return "zh-CN";
  if (language === "ja") return "ja-JP";
  if (language === "ko") return "ko-KR";
  return language;
}

function dateKeyInTimezone(date: Date, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (timeZone !== undefined) {
    options.timeZone = timeZone;
  }
  return new Intl.DateTimeFormat("en-CA", options).format(date);
}

function ymdAddDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number
): string {
  const dt = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export function getStartOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function addLocalMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function getLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getLocalDayDiff(date: Date, now: Date = new Date()): number {
  return Math.round(
    (getStartOfLocalDay(now).getTime() - getStartOfLocalDay(date).getTime()) /
      86_400_000
  );
}

export function formatLocalClock(
  date: Date,
  locale: string | undefined = "en-US"
): string {
  return date.toLocaleString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatLocalMonthDay(
  date: Date,
  options?: {
    includeYear?: boolean;
    locale?: string | undefined;
    monthStyle?: "short" | "long";
  }
): string {
  const locale = options && "locale" in options ? options.locale : "en-US";
  const month = date.toLocaleString(locale, {
    month: options?.monthStyle ?? "short",
  });
  const day = date.getDate();
  if (options?.includeYear) {
    return `${month} ${day}, ${date.getFullYear()}`;
  }
  return `${month} ${day}`;
}

export function formatRelativeElapsedShort(
  date: Date,
  now: Date = new Date()
): string {
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${diffHr}h ago`;
}

export interface FormatSmartDateTimeOptions {
  /** Label for the previous calendar day (from i18n). Default: "Yesterday" */
  yesterdayLabel?: string;
  /** Locale for month names and time. Default: en-US */
  locale?: string;
}

/**
 * Format an instant for chat-style display using the user's timezone setting:
 * - Same calendar day as "now": time only (24h)
 * - Previous calendar day: "Yesterday" label + time (pass translated label)
 * - Same calendar year: month + day + time (no year)
 * - Other years: month + day + year + time
 */
export function formatSmartDateTime(
  dateString: string | null | undefined,
  options?: FormatSmartDateTimeOptions
): string {
  if (!dateString) return "—";

  try {
    const date = parseApiDate(dateString);
    if (!date) return "—";

    const timeZone = resolveTimeZoneForIntl();
    const locale = options?.locale ?? "en-US";
    const yesterdayLabel = options?.yesterdayLabel ?? "Yesterday";

    const now = new Date();
    const todayKey = dateKeyInTimezone(now, timeZone);
    const eventKey = dateKeyInTimezone(date, timeZone);

    const timeOpts: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    if (timeZone !== undefined) {
      timeOpts.timeZone = timeZone;
    }
    const timePart = date.toLocaleTimeString(locale, timeOpts);

    if (eventKey === todayKey) {
      return timePart;
    }

    const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
    const yesterdayKey = ymdAddDays(todayYear, todayMonth, todayDay, -1);

    if (eventKey === yesterdayKey) {
      return `${yesterdayLabel} ${timePart}`;
    }

    const [eventYear] = eventKey.split("-").map(Number);
    const [currentYear] = todayKey.split("-").map(Number);

    const dateTimeOpts: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    if (timeZone !== undefined) {
      dateTimeOpts.timeZone = timeZone;
    }

    if (eventYear === currentYear) {
      return date.toLocaleString(locale, dateTimeOpts);
    }

    return date.toLocaleString(locale, {
      ...dateTimeOpts,
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export interface FormatCalendarDateLabelOptions {
  /** Translated "Today" label (from i18n). Default: "Today" */
  todayLabel?: string;
  /** Translated "Yesterday" label (from i18n). Default: "Yesterday" */
  yesterdayLabel?: string;
  /** BCP-47 locale tag for month names. Default: "en-US" */
  locale?: string;
  /** Month display style for non-relative dates. Default: `short`. */
  monthStyle?: "short" | "long";
}

export function formatCalendarDateLabel(
  input: string | number | null | undefined,
  options?: FormatCalendarDateLabelOptions
): string {
  if (input == null || input === "") return "";

  try {
    const date =
      typeof input === "number" ? new Date(input) : parseApiDate(input);
    if (!date || Number.isNaN(date.getTime())) return "";

    const timeZone = resolveTimeZoneForIntl();
    const locale = options?.locale ?? "en-US";
    const todayLabel = options?.todayLabel ?? "Today";
    const yesterdayLabel = options?.yesterdayLabel ?? "Yesterday";
    const monthStyle = options?.monthStyle ?? "short";

    const now = new Date();
    const todayKey = dateKeyInTimezone(now, timeZone);
    const eventKey = dateKeyInTimezone(date, timeZone);

    if (eventKey === todayKey) {
      return todayLabel;
    }

    const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
    const yesterdayKey = ymdAddDays(todayYear, todayMonth, todayDay, -1);
    if (eventKey === yesterdayKey) {
      return yesterdayLabel;
    }

    const [eventYear] = eventKey.split("-").map(Number);
    const dateOpts: Intl.DateTimeFormatOptions = {
      month: monthStyle,
      day: "numeric",
    };
    if (timeZone !== undefined) {
      dateOpts.timeZone = timeZone;
    }
    if (eventYear !== todayYear) {
      dateOpts.year = "numeric";
    }

    return date.toLocaleDateString(locale, dateOpts);
  } catch {
    return "";
  }
}

export interface FormatReplayDateLabelOptions {
  /** Translated "Today" label (from i18n). Default: "Today" */
  todayLabel?: string;
  /** Translated "Yesterday" label (from i18n). Default: "Yesterday" */
  yesterdayLabel?: string;
  /** BCP-47 locale tag for month names. Default: "en-US" */
  locale?: string;
  /**
   * Whether to include seconds in the time portion. The kanban replay bar
   * scrubs at second granularity so it wants `HH:mm:ss`; consumers that
   * only need minute granularity can pass `false`. Default: `true`.
   */
  withSeconds?: boolean;
  /** Month display style for non-relative dates. Default: `long`. */
  monthStyle?: "short" | "long";
}

/**
 * Format a replay-cursor instant with a smart date prefix:
 * - Same calendar day as now → `Today HH:mm:ss`
 * - Previous calendar day    → `Yesterday HH:mm:ss`
 * - Same calendar year       → `March 29 HH:mm:ss`
 * - Other years              → `March 29, 2024 HH:mm:ss`
 *
 * Differs from `formatSmartDateTime` in three ways: always shows the
 * "Today" label (even when same-day), uses long month names instead of
 * short, and supports HH:mm:ss granularity. The replay bar scrubs at
 * second resolution so the timestamp needs to update visibly as the
 * cursor moves; minute-level display would feel frozen.
 */
export function formatReplayDateLabel(
  input: string | number | null | undefined,
  options?: FormatReplayDateLabelOptions
): string {
  if (input == null || input === "") return "";

  try {
    const date =
      typeof input === "number" ? new Date(input) : parseApiDate(input);
    if (!date || Number.isNaN(date.getTime())) return "";

    const timeZone = resolveTimeZoneForIntl();
    const locale = options?.locale ?? "en-US";
    const todayLabel = options?.todayLabel ?? "Today";
    const yesterdayLabel = options?.yesterdayLabel ?? "Yesterday";
    const withSeconds = options?.withSeconds ?? true;
    const monthStyle = options?.monthStyle ?? "long";

    const now = new Date();
    const todayKey = dateKeyInTimezone(now, timeZone);
    const eventKey = dateKeyInTimezone(date, timeZone);

    const timeOpts: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    if (withSeconds) {
      timeOpts.second = "2-digit";
    }
    if (timeZone !== undefined) {
      timeOpts.timeZone = timeZone;
    }
    const timePart = date.toLocaleTimeString(locale, timeOpts);

    if (eventKey === todayKey) {
      return `${todayLabel} ${timePart}`;
    }

    const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
    const yesterdayKey = ymdAddDays(todayYear, todayMonth, todayDay, -1);
    if (eventKey === yesterdayKey) {
      return `${yesterdayLabel} ${timePart}`;
    }

    const [eventYear] = eventKey.split("-").map(Number);

    const dateOpts: Intl.DateTimeFormatOptions = {
      month: monthStyle,
      day: "numeric",
    };
    if (timeZone !== undefined) {
      dateOpts.timeZone = timeZone;
    }
    if (eventYear !== todayYear) {
      dateOpts.year = "numeric";
    }
    const datePart = date.toLocaleDateString(locale, dateOpts);

    return `${datePart} ${timePart}`;
  } catch {
    return "";
  }
}

/**
 * Format a time range from two timestamps
 *
 * @param startDateString - Start time from API
 * @param endDateString - End time from API
 * @returns A formatted range string like "14:30 - 16:45"
 */
export const formatTimeRange = (
  startDateString: string | null | undefined,
  endDateString: string | null | undefined
): string => {
  const startTime = formatTime(startDateString);
  const endTime = formatTime(endDateString);

  if (startTime === "—" && endTime === "—") return "—";
  if (startTime === "—") return endTime;
  if (endTime === "—") return startTime;

  return `${startTime} - ${endTime}`;
};

/**
 * Get the user's current timezone display name
 *
 * @returns The timezone name for display
 */
export const getTimezoneDisplayName = (): string => {
  const timezone = getCurrentTimezone();

  if (timezone === "auto") {
    // Try to get the browser's timezone name
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "Local";
    }
  }

  if (timezone === "utc") {
    return "UTC";
  }

  return timezone;
};

/**
 * Compare two API dates for sorting
 *
 * @param a - First date string
 * @param b - Second date string
 * @returns Negative if a < b, positive if a > b, 0 if equal
 */
export const compareDates = (
  a: string | null | undefined,
  b: string | null | undefined
): number => {
  const dateA = parseApiDate(a);
  const dateB = parseApiDate(b);

  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;

  return dateA.getTime() - dateB.getTime();
};

// ============================================
// Legacy formatters (browser-local, no timezone setting)
// ============================================

/**
 * Format a Unix timestamp as a readable date/time string
 * @param timestamp - Unix timestamp in seconds
 * @returns Formatted string like "Jan 05, 2025, 14:30"
 */
export const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  const months = [
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

  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, "0");
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");

  return `${month} ${day}, ${year}, ${hours}:${minutes}`;
};

/**
 * Format a payment date string (MM-DD-YYYY) to readable format
 * @param dateString - Date string in MM-DD-YYYY format
 * @returns Formatted string like "January 5, 2025"
 */
export function paymentFormatDate(dateString: string): string {
  if (!dateString) return "";

  const parts = dateString.split("-");
  if (parts.length !== 3) return "";

  const [month, day, year] = parts;
  const date = new Date(`${year}-${month}-${day}`);

  if (isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Format seconds as HH:MM:SS for dashboard display
 * @param seconds - Total seconds
 * @returns Formatted string like "02h 15m 30s"
 */
export function formatDashBoardTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return [
    String(hours).padStart(2, "0") + "h",
    String(minutes).padStart(2, "0") + "m",
    String(secs).padStart(2, "0") + "s",
  ].join(" ");
}

/**
 * Get the user's timezone offset in minutes
 * @returns Timezone offset in minutes (positive for ahead of UTC)
 */
export const getUserTimeZoneOffset = (): number => {
  const now = new Date();
  return -now.getTimezoneOffset();
};
