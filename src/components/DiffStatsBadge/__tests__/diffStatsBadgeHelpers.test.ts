import { describe, expect, it } from "vitest";

import {
  DIFF_STATS_SIZE_CLASSES,
  DIFF_STATS_WEIGHT_CLASSES,
  type DiffStatsBadgeSize,
  type DiffStatsBadgeWeight,
  getDiffStatsSizeClass,
  getDiffStatsWeightClass,
} from "../diffStatsBadgeHelpers";

describe("getDiffStatsSizeClass", () => {
  it("maps each named size to its font-size class", () => {
    expect(getDiffStatsSizeClass("xs")).toBe("text-[11px]");
    expect(getDiffStatsSizeClass("sm")).toBe("text-[12px]");
    expect(getDiffStatsSizeClass("md")).toBe("text-[13px]");
  });

  it("emits no class for the explicit inherit size", () => {
    expect(getDiffStatsSizeClass("inherit")).toBe("");
  });

  it("defaults to inherit (no class) when size is undefined", () => {
    expect(getDiffStatsSizeClass()).toBe("");
    expect(getDiffStatsSizeClass(undefined)).toBe("");
  });

  it("falls back to inherit for unknown values", () => {
    const unknown = "lg" as unknown as DiffStatsBadgeSize;
    expect(getDiffStatsSizeClass(unknown)).toBe("");
  });

  it("keeps every mapped class as a single token (no accidental spaces)", () => {
    for (const cls of Object.values(DIFF_STATS_SIZE_CLASSES)) {
      expect(cls.trim()).toBe(cls);
      expect(cls.split(" ").filter(Boolean).length).toBeLessThanOrEqual(1);
    }
  });

  it("reuses the established 11px/12px diff-stat scale", () => {
    expect(DIFF_STATS_SIZE_CLASSES.xs).toContain("11px");
    expect(DIFF_STATS_SIZE_CLASSES.sm).toContain("12px");
  });
});

describe("getDiffStatsWeightClass", () => {
  it("maps named weights to typography tokens", () => {
    expect(getDiffStatsWeightClass("normal")).toBe("font-normal");
    expect(getDiffStatsWeightClass("medium")).toBe("font-medium");
  });

  it("defaults and falls back to the backwards-compatible medium weight", () => {
    expect(getDiffStatsWeightClass()).toBe("font-medium");
    const unknown = "bold" as unknown as DiffStatsBadgeWeight;
    expect(getDiffStatsWeightClass(unknown)).toBe("font-medium");
  });

  it("keeps every weight mapping as a single token", () => {
    for (const cls of Object.values(DIFF_STATS_WEIGHT_CLASSES)) {
      expect(cls.trim()).toBe(cls);
      expect(cls.split(" ").filter(Boolean)).toHaveLength(1);
    }
  });
});
