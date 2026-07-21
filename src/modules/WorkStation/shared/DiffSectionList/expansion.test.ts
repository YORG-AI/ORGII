import { describe, expect, it } from "vitest";

import { getDefaultDiffSectionExpanded } from "./expansion";

const baseOptions = {
  flat: false,
  isFocused: false,
  collapseSignal: 0,
  defaultCollapsed: false,
  sectionCount: 3,
  collapseThreshold: 10,
};

describe("getDefaultDiffSectionExpanded", () => {
  it("keeps an explicitly default-collapsed list closed", () => {
    expect(
      getDefaultDiffSectionExpanded({
        ...baseOptions,
        defaultCollapsed: true,
      })
    ).toBe(false);
  });

  it("expands an explicitly focused file even in a collapsed list", () => {
    expect(
      getDefaultDiffSectionExpanded({
        ...baseOptions,
        defaultCollapsed: true,
        isFocused: true,
      })
    ).toBe(true);
  });

  it("preserves threshold-based expansion for other consumers", () => {
    expect(getDefaultDiffSectionExpanded(baseOptions)).toBe(true);
    expect(
      getDefaultDiffSectionExpanded({
        ...baseOptions,
        sectionCount: 11,
      })
    ).toBe(false);
  });

  it("keeps flat sections expanded", () => {
    expect(
      getDefaultDiffSectionExpanded({
        ...baseOptions,
        collapseSignal: 1,
        defaultCollapsed: true,
        flat: true,
      })
    ).toBe(true);
  });
});
