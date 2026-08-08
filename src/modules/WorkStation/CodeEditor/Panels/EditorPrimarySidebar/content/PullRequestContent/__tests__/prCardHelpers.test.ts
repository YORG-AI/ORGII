import { describe, expect, it } from "vitest";

import {
  formatStatNumber,
  getPrStatusVariant,
  truncateBranchLabel,
} from "../prCardHelpers";

describe("getPrStatusVariant (re-exported from @src/shared/pr)", () => {
  // Full palette + fallback behavior is exercised in
  // src/shared/pr/__tests__/prStatus.test.ts. Here we only confirm the
  // re-export facade keeps working for existing importers of prCardHelpers.
  it("resolves a known status to its badge + dot classes", () => {
    expect(getPrStatusVariant("open")).toEqual({
      badgeClass: "bg-success-1 text-success-6",
      dotClass: "bg-success-6",
      textClass: "text-success-6",
    });
  });

  it("falls back to a neutral variant for unknown states", () => {
    expect(getPrStatusVariant("pending_review")).toEqual({
      badgeClass: "bg-fill-2 text-text-3",
      dotClass: "bg-text-3",
      textClass: "text-text-3",
    });
  });
});

describe("formatStatNumber (re-exported from @src/shared/pr)", () => {
  // Full coverage lives in src/shared/pr/__tests__/formatStatNumber.test.ts.
  // Here we only confirm the re-export facade keeps working.
  it("inserts thousands separators and collapses NaN", () => {
    expect(formatStatNumber(12345)).toBe("12,345");
    expect(formatStatNumber(Number.NaN)).toBe("0");
  });
});

describe("truncateBranchLabel", () => {
  it("returns short branch names unchanged", () => {
    expect(truncateBranchLabel("test/pr-system-check")).toBe(
      "test/pr-system-check"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(truncateBranchLabel("  feat/x  ")).toBe("feat/x");
  });

  it("returns an empty string for empty / nullish input", () => {
    expect(truncateBranchLabel("")).toBe("");
    expect(truncateBranchLabel(undefined as unknown as string)).toBe("");
  });

  it("caps very long branch names with an ellipsis", () => {
    const long = `feature/${"x".repeat(200)}`;
    const result = truncateBranchLabel(long);
    expect(result).toHaveLength(80);
    expect(result.endsWith("…")).toBe(true);
  });

  it("respects a custom max length", () => {
    expect(truncateBranchLabel("feature/long-branch", 8)).toBe("feature…");
  });

  it("returns just an ellipsis when max is degenerate", () => {
    expect(truncateBranchLabel("anything", 1)).toBe("…");
  });
});
