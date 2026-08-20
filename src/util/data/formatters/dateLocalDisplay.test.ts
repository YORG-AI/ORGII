import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import i18n, { i18nReady } from "@src/i18n";
import zhCommon from "@src/i18n/locales/zh/common.json";

import {
  addLocalDays,
  formatLocalClock,
  formatLocalMonthDay,
  formatRelativeElapsedShort,
  getLocalDateKey,
  getLocalDayDiff,
  getStartOfLocalDay,
  isSameLocalDay,
  toIntlLocaleTag,
} from "./date";

beforeAll(() => {
  i18n.addResourceBundle("zh", "common", zhCommon, true, true);
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("local date display helpers", () => {
  beforeEach(async () => {
    await i18nReady;
    await i18n.changeLanguage("en");
  });

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

  it("uses the resolved app locale when no explicit locale is provided", async () => {
    const date = new Date(2026, 1, 25);
    await i18n.changeLanguage("zh");
    const expected = new Intl.DateTimeFormat("zh-CN", {
      month: "short",
      day: "numeric",
    }).format(date);

    expect(formatLocalMonthDay(date, { locale: undefined })).toBe(expected);
  });

  it("lets an explicit locale override i18n and falls back for unknown locales", async () => {
    const date = new Date(2026, 1, 25);
    await i18n.changeLanguage("zh");

    expect(formatLocalMonthDay(date, { locale: "fr" })).toBe(
      new Intl.DateTimeFormat("fr", {
        month: "short",
        day: "numeric",
      }).format(date)
    );
    expect(toIntlLocaleTag("not_a_locale")).toBe("en-US");
  });

  it("localizes compact relative elapsed labels", async () => {
    const now = new Date(2026, 1, 25, 14, 30, 0);
    const date = new Date(2026, 1, 25, 14, 25, 0);
    await i18n.changeLanguage("zh");

    expect(formatRelativeElapsedShort(date, now)).toBe(
      new Intl.RelativeTimeFormat("zh-CN", {
        numeric: "auto",
        style: "narrow",
      }).format(-5, "minute")
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
