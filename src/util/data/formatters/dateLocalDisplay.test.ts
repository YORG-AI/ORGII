import { describe, expect, it, vi } from "vitest";

import {
  addLocalDays,
  formatDate,
  formatLocalClock,
  formatLocalMonthDay,
  formatRelativeElapsedShort,
  getLocalDateKey,
  getLocalDayDiff,
  getStartOfLocalDay,
  isSameLocalDay,
} from "./date";

describe("local date display helpers", () => {
  it("keeps local calendar operations aligned across UI surfaces", () => {
    const date = new Date(2026, 0, 5, 15, 45, 30);

    expect(getStartOfLocalDay(date)).toEqual(new Date(2026, 0, 5));
    expect(addLocalDays(date, 2)).toEqual(new Date(2026, 0, 7, 15, 45, 30));
    expect(isSameLocalDay(date, new Date(2026, 0, 5, 23, 59))).toBe(true);
    expect(isSameLocalDay(date, new Date(2026, 0, 6))).toBe(false);
    expect(getLocalDateKey(date)).toBe("2026-01-05");
  });

  it("preserves Inbox and Calendar display strings", () => {
    const date = new Date(2026, 1, 25, 14, 30);

    expect(formatLocalClock(date)).toBe("2:30 PM");
    expect(formatLocalMonthDay(date)).toBe("Feb 25");
    expect(formatLocalMonthDay(date, { includeYear: true })).toBe(
      "Feb 25, 2026"
    );
  });

  it("preserves browser-locale month labels when locale is explicitly undefined", () => {
    const date = new Date(2026, 1, 25);
    const expected = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);

    expect(formatLocalMonthDay(date, { locale: undefined })).toBe(expected);
  });

  it("uses an explicit locale for shared date labels", () => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: undefined,
      minute: undefined,
    };
    const instant = "2026-08-06T12:00:00Z";

    expect(formatDate(instant, options, "zh-CN")).toBe(
      new Date(instant).toLocaleString("zh-CN", options)
    );
  });

  it("formats relative elapsed labels used by Inbox", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 25, 14, 30, 0));

    expect(formatRelativeElapsedShort(new Date(2026, 1, 25, 14, 29, 30))).toBe(
      "just now"
    );
    expect(formatRelativeElapsedShort(new Date(2026, 1, 25, 14, 25, 0))).toBe(
      "5m ago"
    );
    expect(formatRelativeElapsedShort(new Date(2026, 1, 25, 12, 30, 0))).toBe(
      "2h ago"
    );

    vi.useRealTimers();
  });

  it("computes local day differences for grouped UI timestamps", () => {
    const now = new Date(2026, 1, 25, 14, 30);

    expect(getLocalDayDiff(new Date(2026, 1, 25, 1, 0), now)).toBe(0);
    expect(getLocalDayDiff(new Date(2026, 1, 24, 23, 59), now)).toBe(1);
    expect(getLocalDayDiff(new Date(2026, 1, 21, 12, 0), now)).toBe(4);
  });
});
