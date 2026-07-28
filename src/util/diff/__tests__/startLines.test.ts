import { describe, expect, it } from "vitest";

import { shouldTrustDiffStartLines } from "../startLines";

describe("shouldTrustDiffStartLines", () => {
  it("rejects missing events", () => {
    expect(shouldTrustDiffStartLines(null)).toBe(false);
    expect(shouldTrustDiffStartLines(undefined)).toBe(false);
  });

  it("trusts ordinary edits and unified diff hunks", () => {
    expect(shouldTrustDiffStartLines({ args: {} })).toBe(true);
    expect(
      shouldTrustDiffStartLines({
        args: { patch: "@@ -4,2 +9,3 @@\n-old\n+new" },
      })
    ).toBe(true);
  });

  it("rejects compact patch placeholders unless the result has a real diff", () => {
    const compactPatch = { args: { patch: "*** Begin Patch" } };
    expect(shouldTrustDiffStartLines(compactPatch)).toBe(false);
    expect(
      shouldTrustDiffStartLines({
        ...compactPatch,
        result: { output: { success: { diffString: "@@ -1 +1 @@" } } },
      })
    ).toBe(true);
  });
});
