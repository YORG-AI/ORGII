import { describe, expect, it } from "vitest";

import { advanceSubagentViewState } from "./SubagentPipCard";

const state = {
  sessionIds: ["a", "b", "c", "d", "e", "f"],
  pageIndex: 1,
  gridExpanded: true,
  expandedSessionId: "e",
};
describe("advanceSubagentViewState", () => {
  it("preserves the same roster state", () => {
    expect(advanceSubagentViewState(state, [...state.sessionIds])).toBe(state);
  });
  it("keeps expansion and anchors the selected cell when siblings arrive or reorder", () => {
    const next = advanceSubagentViewState(state, [
      "e",
      "new",
      "a",
      "b",
      "c",
      "d",
      "f",
    ]);
    expect(next).toMatchObject({
      pageIndex: 0,
      gridExpanded: true,
      expandedSessionId: "e",
    });
  });
  it("anchors the old page when the expanded cell disappears", () => {
    const next = advanceSubagentViewState(state, ["a", "b", "f", "c", "d"]);
    expect(next).toMatchObject({
      pageIndex: 0,
      gridExpanded: true,
      expandedSessionId: null,
    });
  });
  it("clamps removed pages and clears expansion for an unrelated roster", () => {
    expect(advanceSubagentViewState(state, ["new"])).toMatchObject({
      pageIndex: 0,
      gridExpanded: false,
      expandedSessionId: null,
    });
    expect(advanceSubagentViewState(state, [])).toMatchObject({
      pageIndex: 0,
      gridExpanded: false,
      expandedSessionId: null,
    });
  });
  it("keeps a surviving first item on the strip page after insertion", () => {
    const next = advanceSubagentViewState(
      { ...state, gridExpanded: false, expandedSessionId: null },
      ["new", "a", "b", "c", "d", "e", "f"]
    );
    expect(next.pageIndex).toBe(1);
  });
});
