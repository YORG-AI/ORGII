import { describe, expect, it } from "vitest";

import { getInlineMentionQuery } from "../mentionQuery";

describe("getInlineMentionQuery", () => {
  it("excludes the @ trigger when the keydown fallback ran before input", () => {
    expect(
      getInlineMentionQuery("@", 1, { startOffset: 0, hasAtChar: true })
    ).toBe("");
    expect(
      getInlineMentionQuery("@planner", 8, {
        startOffset: 0,
        hasAtChar: true,
      })
    ).toBe("planner");
  });

  it("preserves normal inline and trigger-button query offsets", () => {
    expect(
      getInlineMentionQuery("before @planner", 15, {
        startOffset: 8,
        hasAtChar: true,
      })
    ).toBe("planner");
    expect(
      getInlineMentionQuery("planner", 7, {
        startOffset: 0,
        hasAtChar: false,
      })
    ).toBe("planner");
  });
});
