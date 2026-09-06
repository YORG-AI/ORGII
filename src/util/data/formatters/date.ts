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
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

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
  now: Date = new Date(),
  locale?: string
): string {
  return formatRelativeTime(date.getTime(), "elapsed", locale, now.getTime());
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
