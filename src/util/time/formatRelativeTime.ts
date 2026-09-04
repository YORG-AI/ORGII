import { resolveTimeZoneForIntl } from "@src/config/timezone";

export type RelativeTimeStyle = "short" | "compact" | "long" | "nano" | "issue";

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function toMs(timestamp: number | string | null | undefined): number | null {
  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return null;
  }
  if (typeof timestamp === "number") return timestamp;
  const parsed = new Date(timestamp).getTime();
  return isNaN(parsed) ? null : parsed;
}

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * @param timestamp - Unix ms number, ISO string, or null/undefined
 * @param style
 * @param locale - Optional BCP 47 locale for localized long-form output
 *   - "short"   (default): "Now", "2 min ago", "Yesterday", "5 days ago", date fallback
 *   - "compact": "just now", "2 mins", "3 hrs", "1 day", "1 wk", "2 mos", "1 yr"
 *   - "long":    "just now", "2 minutes ago", "3 hours ago", "1 month ago", "2 years ago"
 *   - "nano":    "Now", "5m", "3h", "2d", "1w", "3mo", "1y"
 *   - "issue":   "today", "yesterday", "5d ago", "2mo ago", "1y ago"
 */
export function formatRelativeTime(
  timestamp: number | string | null | undefined,
  style: RelativeTimeStyle = "short",
  locale?: string
): string {
  const ms = toMs(timestamp);
  if (ms === null) return "";

  const diffMs = Date.now() - ms;
  if (diffMs < 0) return style === "short" ? "Now" : "just now";

  const diffSec = Math.floor(diffMs / SEC);
  const diffMin = Math.floor(diffMs / MIN);
  const diffHr = Math.floor(diffMs / HR);
  const diffDay = Math.floor(diffMs / DAY);
  const diffWeek = Math.floor(diffMs / WEEK);
  const diffMonth = Math.floor(diffMs / MONTH);
  const diffYear = Math.floor(diffMs / YEAR);

  if (locale && style === "long") {
    const formatter = new Intl.RelativeTimeFormat(locale, {
      numeric: "always",
      style: "long",
    });
    if (diffSec < 60) return formatter.format(0, "second");
    if (diffMin < 60) return formatter.format(-diffMin, "minute");
    if (diffHr < 24) return formatter.format(-diffHr, "hour");
    if (diffDay < 7) return formatter.format(-diffDay, "day");
    if (diffWeek < 4) return formatter.format(-diffWeek, "week");
    if (diffMonth < 12) return formatter.format(-diffMonth, "month");
    return formatter.format(-diffYear, "year");
  }

  if (style === "short") {
    if (diffSec < 60) return "Now";
    if (diffMin < 60) return `${diffMin} min ago`;
    if (diffHr < 24) return `${diffHr} hr ago`;
    if (diffDay === 1) return "Yesterday";
    if (diffDay < 7) return `${diffDay} days ago`;
    // Honor the explicit timezone preference like every other formatter
    // (`resolveTimeZoneForIntl` answers undefined for "auto", which Intl
    // treats as the system zone).
    return new Date(ms).toLocaleDateString(undefined, {
      timeZone: resolveTimeZoneForIntl(),
    });
  }

  if (style === "compact") {
    if (diffSec < 60) return "just now";
    if (diffMin < 60) return diffMin === 1 ? "1 min" : `${diffMin} mins`;
    if (diffHr < 24) return diffHr === 1 ? "1 hr" : `${diffHr} hrs`;
    if (diffDay < 7) return diffDay === 1 ? "1 day" : `${diffDay} days`;
    if (diffWeek < 4) return diffWeek === 1 ? "1 wk" : `${diffWeek} wks`;
    if (diffMonth < 12) return diffMonth === 1 ? "1 mo" : `${diffMonth} mos`;
    return diffYear === 1 ? "1 yr" : `${diffYear} yrs`;
  }

  if (style === "long") {
    if (diffSec < 60) return "just now";
    if (diffMin < 60)
      return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
    if (diffHr < 24) return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
    if (diffDay < 7) return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
    if (diffWeek < 4)
      return diffWeek === 1 ? "1 week ago" : `${diffWeek} weeks ago`;
    if (diffMonth < 12)
      return diffMonth === 1 ? "1 month ago" : `${diffMonth} months ago`;
    return diffYear === 1 ? "1 year ago" : `${diffYear} years ago`;
  }

  if (style === "nano") {
    if (diffSec < 60) return "Now";
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHr < 24) return `${diffHr}h`;
    if (diffDay < 7) return `${diffDay}d`;
    if (diffWeek < 4) return `${diffWeek}w`;
    if (diffMonth < 12) return `${diffMonth}mo`;
    return `${diffYear}y`;
  }

  // issue: day-granularity compact for GitHub issue/PR displays
  if (diffDay === 0) return "today";
  if (diffDay === 1) return "yesterday";
  if (diffDay < 30) return `${diffDay}d ago`;
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${diffYear}y ago`;
}
