import { describe, expect, it } from "vitest";

import { formatCompactHour } from "./usageFormat";

describe("formatCompactHour", () => {
  it.each([
    [0, "12AM"],
    [2, "2AM"],
    [11, "11AM"],
    [12, "12PM"],
    [17, "5PM"],
    [23, "11PM"],
  ])("formats hour %i as %s", (hour, expected) => {
    expect(formatCompactHour(new Date(2026, 6, 21, hour))).toBe(expected);
  });
});
