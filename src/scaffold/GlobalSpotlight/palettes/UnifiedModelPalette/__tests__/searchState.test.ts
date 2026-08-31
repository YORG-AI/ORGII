import { describe, expect, it } from "vitest";

import { advancePaletteSearchState } from "../searchState";

describe("advancePaletteSearchState", () => {
  it("clears a stale query in the same render that reopens the palette", () => {
    const closed = { isOpen: false, query: "claude" };

    expect(advancePaletteSearchState(closed, false)).toBe(closed);
    expect(advancePaletteSearchState(closed, true)).toEqual({
      isOpen: true,
      query: "",
    });
  });

  it("preserves the query while closing", () => {
    expect(
      advancePaletteSearchState({ isOpen: true, query: "gpt" }, false)
    ).toEqual({ isOpen: false, query: "gpt" });
  });
});
