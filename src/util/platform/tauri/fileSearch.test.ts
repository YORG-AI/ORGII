import { describe, expect, it } from "vitest";

import { shouldPrewarmFileIndex } from "./fileSearch";

describe("shouldPrewarmFileIndex", () => {
  it("allows visible and non-DOM callers", () => {
    expect(shouldPrewarmFileIndex("visible")).toBe(true);
    expect(shouldPrewarmFileIndex(undefined)).toBe(true);
  });

  it("skips proactive work for hidden windows", () => {
    expect(shouldPrewarmFileIndex("hidden")).toBe(false);
  });
});
