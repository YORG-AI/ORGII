import { describe, expect, it } from "vitest";

import {
  getProjectsSectionVisibleCountKey,
  getSessionSectionVisibleCountKey,
  resetNewlyCollapsedSectionVisibleCounts,
  resetScopedSectionPagination,
} from "./sectionPagination";

describe("sidebar section pagination", () => {
  it("maps session section ids to their per-group visible-count keys", () => {
    expect(getSessionSectionVisibleCountKey("today", "byTime")).toBe(
      "time:today"
    );
    expect(getSessionSectionVisibleCountKey("cursor_ide", "byAgent")).toBe(
      "agent:cursor_ide"
    );
    expect(getSessionSectionVisibleCountKey("agent-org:org-1", "byAgent")).toBe(
      "agent-org:org-1"
    );
    expect(
      getSessionSectionVisibleCountKey("/workspace/orgii", "byWorkspace")
    ).toBe("workspace:/workspace/orgii");
    expect(getSessionSectionVisibleCountKey("pinned", "byWorkspace")).toBe(
      "pinned"
    );
    expect(
      getProjectsSectionVisibleCountKey("projects-work-items:recent")
    ).toBe("projects-work-items:recent");
  });

  it("evicts only a newly collapsed section's expanded row count", () => {
    const currentVisibleCounts = new Map([
      ["time:today", 30],
      ["time:yesterday", 20],
    ]);

    const nextVisibleCounts = resetNewlyCollapsedSectionVisibleCounts({
      currentVisibleCounts,
      previousCollapsedSectionIds: new Set<string>(),
      nextCollapsedSectionIds: new Set(["today"]),
      resolveVisibleCountKey: (sectionId) =>
        getSessionSectionVisibleCountKey(sectionId, "byTime"),
    });

    expect(nextVisibleCounts).toEqual(new Map([["time:yesterday", 20]]));
    expect(currentVisibleCounts).toEqual(
      new Map([
        ["time:today", 30],
        ["time:yesterday", 20],
      ])
    );
  });

  it("preserves map identity when expanding or collapsing an unpaged section", () => {
    const currentVisibleCounts = new Map([["time:today", 20]]);

    const afterExpand = resetNewlyCollapsedSectionVisibleCounts({
      currentVisibleCounts,
      previousCollapsedSectionIds: new Set(["today"]),
      nextCollapsedSectionIds: new Set<string>(),
      resolveVisibleCountKey: (sectionId) =>
        getSessionSectionVisibleCountKey(sectionId, "byTime"),
    });
    const afterUnpagedCollapse = resetNewlyCollapsedSectionVisibleCounts({
      currentVisibleCounts,
      previousCollapsedSectionIds: new Set<string>(),
      nextCollapsedSectionIds: new Set(["terminals"]),
      resolveVisibleCountKey: (sectionId) =>
        getSessionSectionVisibleCountKey(sectionId, "byTime"),
    });

    expect(afterExpand).toBe(currentVisibleCounts);
    expect(afterUnpagedCollapse).toBe(currentVisibleCounts);
  });

  it("returns scoped cloud pagination to its default first page", () => {
    expect(
      resetScopedSectionPagination({ scopeKey: "org-1", visibleCount: 30 }, 10)
    ).toEqual({ scopeKey: "", visibleCount: 10 });

    const resetState = { scopeKey: "", visibleCount: 10 };
    expect(resetScopedSectionPagination(resetState, 10)).toBe(resetState);
  });
});
