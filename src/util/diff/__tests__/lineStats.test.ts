import { describe, expect, it } from "vitest";

import { countContentLines, resolveLineDiffStats } from "../lineStats";

describe("resolveLineDiffStats", () => {
  const replacementDiff = "@@ -1 +1 @@\n-before\n+after";

  it("uses supplied additions and deletions", () => {
    expect(resolveLineDiffStats({ additions: 4, deletions: 2 })).toEqual({
      additions: 4,
      deletions: 2,
    });
  });

  it("preserves a supplied zero and resolves the missing side independently", () => {
    expect(
      resolveLineDiffStats({ additions: 0, unifiedDiff: replacementDiff })
    ).toEqual({ additions: 0, deletions: 1 });
  });

  it("counts equal-length replacements instead of treating them as unchanged", () => {
    expect(resolveLineDiffStats({ unifiedDiff: replacementDiff })).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("uses full content only for known added or deleted files", () => {
    expect(resolveLineDiffStats({ addedContent: "one\ntwo" })).toEqual({
      additions: 2,
      deletions: 0,
    });
    expect(resolveLineDiffStats({ deletedContent: "one\ntwo" })).toEqual({
      additions: 0,
      deletions: 2,
    });
  });

  it("does not invent modified-file deltas without exact data", () => {
    expect(resolveLineDiffStats({ additions: 3 })).toEqual({
      additions: 3,
      deletions: 0,
    });
  });
});

describe("countContentLines", () => {
  it("treats empty or missing content as zero lines", () => {
    expect(countContentLines("")).toBe(0);
    expect(countContentLines(undefined)).toBe(0);
  });
});
