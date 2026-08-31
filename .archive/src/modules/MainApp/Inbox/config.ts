/**
 * Inbox Configuration
 *
 * Configuration for inbox channels (message grouping) and date formatting.
 */
import type { InboxCategory } from "@src/api/types/inbox";
import {
  DiffIcon,
  type IconSvgElement,
  ListTodoIcon,
  Store01Icon,
} from "@src/icons";
import {
  formatLocalClock,
  formatLocalMonthDay,
  formatRelativeElapsedShort,
  getLocalDateKey,
  getLocalDayDiff,
  isSameLocalDay,
} from "@src/util/data/formatters/date";

// ============================================
// Channels
// ============================================

export type { InboxCategory };

export interface InboxChannelConfig {
  id: InboxCategory;
  labelKey: string;
  icon: IconSvgElement;
  color: string;
}

export const INBOX_CHANNELS: InboxChannelConfig[] = [
  {
    id: "git",
    labelKey: "inbox.channels.git",
    icon: DiffIcon,
    color: "#f97316",
  },
  {
    id: "workitems",
    labelKey: "inbox.channels.workItems",
    icon: ListTodoIcon,
    color: "#3b82f6",
  },
  {
    id: "promotion",
    labelKey: "inbox.channels.promotions",
    icon: Store01Icon,
    color: "#8b5cf6",
  },
];

export const DEFAULT_INBOX_CHANNEL: InboxCategory = INBOX_CHANNELS[0].id;

export function getChannelConfig(
  channelId: InboxCategory
): InboxChannelConfig | undefined {
  return INBOX_CHANNELS.find((ch) => ch.id === channelId);
}

export function getCategoryChannelConfig(
  category: InboxCategory
): InboxChannelConfig | undefined {
  return INBOX_CHANNELS.find((ch) => ch.id === category);
}

// ============================================
// Date formatting
// ============================================

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface InboxDateParts {
  /** The main date/time string — rendered bold */
  time: string;
  /** Optional relative suffix like "(5m ago)" — rendered normal weight */
  suffix?: string;
}

/**
 * Format a date for inbox display (structured):
 * - Today → time: "2:30 PM", suffix: "(5m ago)"
 * - Yesterday → time: "Yesterday, 2:30 PM"
 * - 2–6 days ago → time: "Mon, 2:30 PM"
 * - 7+ days, same year → time: "Feb 25, 2:30 PM"
 * - Different year → time: "Feb 25, 2025, 2:30 PM"
 */
export function formatInboxDate(iso: string): InboxDateParts {
  const date = new Date(iso);
  const now = new Date();
  const clock = formatLocalClock(date);
  const dayDiff = getLocalDayDiff(date, now);

  if (dayDiff === 0) {
    return {
      time: clock,
      suffix: `(${formatRelativeElapsedShort(date, now)})`,
    };
  }
  if (dayDiff === 1) return { time: `Yesterday, ${clock}` };
  if (dayDiff >= 2 && dayDiff <= 6)
    return { time: `${DAY_NAMES[date.getDay()]}, ${clock}` };

  const monthDay = formatLocalMonthDay(date, {
    includeYear: date.getFullYear() !== now.getFullYear(),
  });
  return { time: `${monthDay}, ${clock}` };
}

/** Returns true if the ISO date is from today (needs live updates). */
export function isToday(iso: string): boolean {
  return isSameLocalDay(new Date(iso), new Date());
}

/**
 * Compact date for feed message timestamps:
 * - Today → "5m ago" / "2h ago" / "just now"
 * - Yesterday → "Yesterday"
 * - 2–6 days ago → "2d ago"
 * - 7+ days, same year → "Feb 25"
 * - Different year → "Feb 25, 2025"
 */
export function formatInboxDateCompact(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const dayDiff = getLocalDayDiff(date, now);

  if (dayDiff === 0) return formatRelativeElapsedShort(date, now);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff >= 2 && dayDiff <= 6) return `${dayDiff}d ago`;

  return formatLocalMonthDay(date, {
    includeYear: date.getFullYear() !== now.getFullYear(),
  });
}

/**
 * Returns a date group label for feed date separators.
 * - Today → "Today"
 * - Yesterday → "Yesterday"
 * - Same year → "Mon, Feb 25"
 * - Different year → "Mon, Feb 25, 2025"
 */
export function formatDateGroupLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const dayDiff = getLocalDayDiff(date, now);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";

  const dayName = DAY_NAMES[date.getDay()];
  return `${dayName}, ${formatLocalMonthDay(date, {
    includeYear: date.getFullYear() !== now.getFullYear(),
  })}`;
}

/** Returns a calendar-day key (YYYY-MM-DD) for grouping messages by date. */
export function getDateKey(iso: string): string {
  return getLocalDateKey(new Date(iso));
}
