import { resolveTimeZoneForIntl } from "@src/config/timezone";
import i18n from "@src/i18n";

export type RelativeTimeStyle =
  | "short"
  | "compact"
  | "long"
  | "nano"
  | "issue"
  | "elapsed";

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
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parsed = new Date(timestamp).getTime();
  return isNaN(parsed) ? null : parsed;
}

function resolveLocale(locale: string | undefined): string {
  return locale ?? i18n.language ?? i18n.resolvedLanguage ?? "en";
}

function formatRelative(
  locale: string,
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  style: Intl.RelativeTimeFormatStyle,
  numeric: Intl.RelativeTimeFormatNumeric = "always"
): string {
  return new Intl.RelativeTimeFormat(locale, { numeric, style }).format(
    value,
    unit
  );
}

function formatImmediate(
  locale: string,
  style: Intl.RelativeTimeFormatStyle,
  useAppTranslation: boolean
): string {
  const fallback = formatRelative(locale, 0, "second", style, "auto");
  return useAppTranslation
    ? i18n.t("common:relativeDate.justNow", { defaultValue: fallback })
    : fallback;
}

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * @param timestamp - Unix ms number, ISO string, or null/undefined
 * @param style
 * @param locale - Optional BCP 47 locale. Defaults to the selected app language.
 *   - "short"   (default): localized short form, then a date after one week
 *   - "compact": localized short form through years
 *   - "long":    localized long form through years
 *   - "nano":    localized narrow form through years
 *   - "issue":   localized narrow day/month/year form with today/yesterday labels
 *   - "elapsed": localized narrow seconds/minutes/hours form
 * @param now - Injectable clock for deterministic callers and tests
 */
export function formatRelativeTime(
  timestamp: number | string | null | undefined,
  style: RelativeTimeStyle = "short",
  locale?: string,
  now: number = Date.now()
): string {
  const ms = toMs(timestamp);
  if (ms === null) return "";

  const resolvedLocale = resolveLocale(locale);
  const diffMs = now - ms;
  const intlStyle: Intl.RelativeTimeFormatStyle =
    style === "long"
      ? "long"
      : style === "nano" || style === "issue" || style === "elapsed"
        ? "narrow"
        : "short";
  if (diffMs < 0) {
    return formatImmediate(resolvedLocale, intlStyle, locale === undefined);
  }

  const diffSec = Math.floor(diffMs / SEC);
  const diffMin = Math.floor(diffMs / MIN);
  const diffHr = Math.floor(diffMs / HR);
  const diffDay = Math.floor(diffMs / DAY);
  const diffWeek = Math.floor(diffMs / WEEK);
  const diffMonth = Math.floor(diffMs / MONTH);
  const diffYear = Math.floor(diffMs / YEAR);

  if (style === "short") {
    if (diffSec < 60)
      return formatImmediate(resolvedLocale, "short", locale === undefined);
    if (diffMin < 60)
      return formatRelative(resolvedLocale, -diffMin, "minute", "short");
    if (diffHr < 24)
      return formatRelative(resolvedLocale, -diffHr, "hour", "short");
    if (diffDay < 7)
      return formatRelative(
        resolvedLocale,
        -diffDay,
        "day",
        "short",
        diffDay === 1 ? "auto" : "always"
      );
    // Honor the explicit timezone preference like every other formatter
    // (`resolveTimeZoneForIntl` answers undefined for "auto", which Intl
    // treats as the system zone).
    return new Date(ms).toLocaleDateString(resolvedLocale, {
      timeZone: resolveTimeZoneForIntl(),
    });
  }

  if (style === "compact") {
    if (diffSec < 60)
      return formatImmediate(resolvedLocale, "short", locale === undefined);
    if (diffMin < 60)
      return formatRelative(resolvedLocale, -diffMin, "minute", "short");
    if (diffHr < 24)
      return formatRelative(resolvedLocale, -diffHr, "hour", "short");
    if (diffDay < 7)
      return formatRelative(resolvedLocale, -diffDay, "day", "short");
    if (diffWeek < 4)
      return formatRelative(resolvedLocale, -diffWeek, "week", "short");
    if (diffMonth < 12)
      return formatRelative(resolvedLocale, -diffMonth, "month", "short");
    return formatRelative(resolvedLocale, -diffYear, "year", "short");
  }

  if (style === "long") {
    if (diffSec < 60)
      return formatImmediate(resolvedLocale, "long", locale === undefined);
    if (diffMin < 60)
      return formatRelative(resolvedLocale, -diffMin, "minute", "long");
    if (diffHr < 24)
      return formatRelative(resolvedLocale, -diffHr, "hour", "long");
    if (diffDay < 7)
      return formatRelative(resolvedLocale, -diffDay, "day", "long");
    if (diffWeek < 4)
      return formatRelative(resolvedLocale, -diffWeek, "week", "long");
    if (diffMonth < 12)
      return formatRelative(resolvedLocale, -diffMonth, "month", "long");
    return formatRelative(resolvedLocale, -diffYear, "year", "long");
  }

  if (style === "nano") {
    if (diffSec < 60)
      return formatImmediate(resolvedLocale, "narrow", locale === undefined);
    if (diffMin < 60)
      return formatRelative(resolvedLocale, -diffMin, "minute", "narrow");
    if (diffHr < 24)
      return formatRelative(resolvedLocale, -diffHr, "hour", "narrow");
    if (diffDay < 7)
      return formatRelative(resolvedLocale, -diffDay, "day", "narrow");
    if (diffWeek < 4)
      return formatRelative(resolvedLocale, -diffWeek, "week", "narrow");
    if (diffMonth < 12)
      return formatRelative(resolvedLocale, -diffMonth, "month", "narrow");
    return formatRelative(resolvedLocale, -diffYear, "year", "narrow");
  }

  if (style === "elapsed") {
    if (diffSec < 60)
      return formatImmediate(resolvedLocale, "narrow", locale === undefined);
    if (diffMin < 60)
      return formatRelative(resolvedLocale, -diffMin, "minute", "narrow");
    return formatRelative(resolvedLocale, -diffHr, "hour", "narrow");
  }

  if (style === "issue") {
    // Day-granularity compact form for GitHub issue/PR displays.
    if (diffDay < 2)
      return formatRelative(resolvedLocale, -diffDay, "day", "narrow", "auto");
    if (diffDay < 30)
      return formatRelative(resolvedLocale, -diffDay, "day", "narrow");
    if (diffMonth < 12)
      return formatRelative(resolvedLocale, -diffMonth, "month", "narrow");
    return formatRelative(resolvedLocale, -diffYear, "year", "narrow");
  }

  const unhandledStyle: never = style;
  return unhandledStyle;
}

const COMPACT_AGE_UNITS: ReadonlyArray<readonly [ms: number, suffix: string]> =
  [
    [YEAR, "y"],
    [MONTH, "mo"],
    [WEEK, "w"],
    [DAY, "d"],
    [HR, "h"],
    [MIN, "m"],
  ];

/**
 * Bare compact age like "11m", "11h", "2d" — always English abbreviations,
 * never localized, and never suffixed with "ago"/"in". Intl.RelativeTimeFormat
 * (which every style above uses) can't drop that suffix on its own, and
 * always following the app's display language is wrong for UI slots — like a
 * sidebar row's fixed-width shortcut — that read as a compact age badge
 * rather than a sentence.
 *
 * @param timestamp - Unix ms number, ISO string, or null/undefined
 * @param now - Injectable clock for deterministic callers and tests
 */
export function formatCompactAge(
  timestamp: number | string | null | undefined,
  now: number = Date.now()
): string {
  const ms = toMs(timestamp);
  if (ms === null) return "";

  const diffMs = now - ms;
  if (diffMs < MIN) return "now";

  for (const [unitMs, suffix] of COMPACT_AGE_UNITS) {
    if (diffMs >= unitMs) return `${Math.floor(diffMs / unitMs)}${suffix}`;
  }
  return "now";
}
