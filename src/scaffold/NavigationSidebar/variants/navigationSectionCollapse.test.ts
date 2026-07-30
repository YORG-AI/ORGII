import { describe, expect, it } from "vitest";

import { isNavigationSectionCollapsed } from "./navigationSectionCollapse";

describe("isNavigationSectionCollapsed", () => {
  it("preserves a collapsed section while its rows are filtered", () => {
    expect(
      isNavigationSectionCollapsed({
        collapsibleSections: true,
        collapsedSectionIds: new Set(["cloud-my-sessions"]),
        sectionId: "cloud-my-sessions",
      })
    ).toBe(true);
  });

  it("does not collapse sections when section collapsing is disabled", () => {
    expect(
      isNavigationSectionCollapsed({
        collapsibleSections: false,
        collapsedSectionIds: new Set(["cloud-my-sessions"]),
        sectionId: "cloud-my-sessions",
      })
    ).toBe(false);
  });
});
