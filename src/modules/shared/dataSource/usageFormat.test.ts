import { describe, expect, it } from "vitest";

import {
  formatCompactHour,
  formatTokensAxis,
  formatUsdAxis,
} from "./usageFormat";

/** Ticks wider than this overflow the reserved Y-axis width and get clipped. */
const MAX_AXIS_LABEL_CHARS = 6;

describe("formatTokensAxis", () => {
  it.each([
    [0, "0"],
    [-5, "0"],
    [Number.NaN, "0"],
    [999, "999"],
    [1_200, "1.2K"],
    [12_500, "12.5K"],
    [1_000_000, "1M"],
    [4_050_000, "4.05M"],
    [99_900_000, "99.9M"],
    [700_000_000, "700M"],
    [4_050_000_000, "4.05B"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatTokensAxis(value)).toBe(expected);
  });

  it("keeps every label narrow enough to render inside the axis", () => {
    for (let exponent = 0; exponent <= 12; exponent += 1) {
      for (const mantissa of [1, 1.5, 4.05, 7, 9.99]) {
        const label = formatTokensAxis(mantissa * 10 ** exponent);
        expect(label.length).toBeLessThanOrEqual(MAX_AXIS_LABEL_CHARS);
      }
    }
  });
});

describe("formatUsdAxis", () => {
  it.each([
    [0, "$0"],
    [Number.NaN, "$0"],
    [0.30000000000000004, "$0.3"],
    [2.5, "$2.5"],
    [200, "$200"],
    [1_250.5, "$1.3K"],
    [12_500, "$13K"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatUsdAxis(value)).toBe(expected);
  });
});

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
