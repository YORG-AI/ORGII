import { describe, expect, it } from "vitest";

import { truncateBranchLabel } from "../prCardHelpers";

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
