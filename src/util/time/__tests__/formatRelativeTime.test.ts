import { afterEach, describe, expect, it, vi } from "vitest";

import { formatRelativeTime } from "../formatRelativeTime";

/**
 * `formatRelativeTime`'s >7-day date fallback must honor the explicit
 * timezone preference, like every other formatter in the app (which route
 * through `resolveTimeZoneForIntl`). Only "auto" should follow the system
 * zone.
 *
 * TZ is pinned to a negative offset so a preference of UTC is observably
 * different from the system zone.
 */
process.env.TZ = "America/Los_Angeles";

const { getCurrentTimezoneMock } = vi.hoisted(() => ({
  getCurrentTimezoneMock: vi.fn<() => string>(() => "auto"),
}));

vi.mock("@src/config/timezone", () => ({
  getCurrentTimezone: getCurrentTimezoneMock,
  resolveTimeZoneForIntl: () => {
    const timezone = getCurrentTimezoneMock();
    if (timezone === "auto") return undefined;
    return timezone === "utc" ? "UTC" : timezone;
  },
}));

/** 2026-07-30T00:00:00Z is still 07/29 in Los Angeles. */
const OLD_INSTANT = Date.parse("2026-07-30T00:00:00Z");
/** Far enough past OLD_INSTANT to land in the ">7 days" date fallback. */
const NOW = Date.parse("2026-08-20T00:00:00Z");

afterEach(() => {
  vi.useRealTimers();
  getCurrentTimezoneMock.mockReturnValue("auto");
});

describe("formatRelativeTime date fallback", () => {
  it("renders in the system zone when the preference is auto", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getCurrentTimezoneMock.mockReturnValue("auto");

    expect(formatRelativeTime(OLD_INSTANT, "short")).toBe(
      new Date(OLD_INSTANT).toLocaleDateString(undefined, {
        timeZone: "America/Los_Angeles",
      })
    );
  });

  it("honors an explicit timezone preference instead of the system zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getCurrentTimezoneMock.mockReturnValue("utc");

    const rendered = formatRelativeTime(OLD_INSTANT, "short");
    expect(rendered).toBe(
      new Date(OLD_INSTANT).toLocaleDateString(undefined, { timeZone: "UTC" })
    );
    // The bug: the system zone puts this instant on the previous day.
    expect(rendered).not.toBe(
      new Date(OLD_INSTANT).toLocaleDateString(undefined, {
        timeZone: "America/Los_Angeles",
      })
    );
  });

  it("still returns relative phrasing inside the 7-day window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(OLD_INSTANT + 2 * 24 * 60 * 60 * 1000);
    getCurrentTimezoneMock.mockReturnValue("utc");

    expect(formatRelativeTime(OLD_INSTANT, "short")).toBe("2 days ago");
  });

  it("uses Intl-relative phrasing when the caller provides a locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const instant = NOW - 2 * 60 * 60 * 1000;

    expect(formatRelativeTime(instant, "long", "zh-CN")).toBe(
      new Intl.RelativeTimeFormat("zh-CN", {
        numeric: "always",
        style: "long",
      }).format(-2, "hour")
    );
  });
});
