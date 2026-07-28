import { describe, expect, it } from "vitest";

import { resolveInitialTopMostItemIndex } from "./VirtualizedListBase";

describe("resolveInitialTopMostItemIndex", () => {
  // Regression guard: Virtuoso normalizes initialTopMostItemIndex with
  // `typeof t === "number" ? { index: t } : t` and then reads `.align` off the
  // result, so an explicit `undefined` throws
  // "undefined is not an object (evaluating 'e.align')" on mount rather than
  // being treated as an absent prop.
  it.each([
    ["no saved scroll", 0, 34],
    ["negative scroll", -120, 34],
    ["NaN scroll", Number.NaN, 34],
    ["infinite scroll", Number.POSITIVE_INFINITY, 34],
    ["zero item height", 400, 0],
    ["NaN item height", 400, Number.NaN],
  ])("returns a number for %s", (_label, scrollTop, itemHeight) => {
    const result = resolveInitialTopMostItemIndex(scrollTop, itemHeight);
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("maps a saved offset onto the row it lands in", () => {
    expect(resolveInitialTopMostItemIndex(340, 34)).toBe(10);
    // Partial rows resolve to the row that owns the offset, not the next one.
    expect(resolveInitialTopMostItemIndex(345, 34)).toBe(10);
  });

  it("starts at the top when there is nothing to restore", () => {
    expect(resolveInitialTopMostItemIndex(0, 34)).toBe(0);
  });
});
