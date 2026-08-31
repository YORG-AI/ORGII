import { describe, expect, it } from "vitest";

import { advanceFlipState } from "./PassportBook";

describe("advanceFlipState", () => {
  it("keeps the current direction until the sheet changes", () => {
    const state = { sheetIndex: 2, direction: "backward" as const };
    expect(advanceFlipState(state, 2)).toBe(state);
  });

  it("derives forward and backward direction from the prop transition", () => {
    const forward = advanceFlipState(
      { sheetIndex: 1, direction: "backward" },
      3
    );
    expect(forward).toEqual({ sheetIndex: 3, direction: "forward" });
    expect(advanceFlipState(forward, 0)).toEqual({
      sheetIndex: 0,
      direction: "backward",
    });
  });
});
