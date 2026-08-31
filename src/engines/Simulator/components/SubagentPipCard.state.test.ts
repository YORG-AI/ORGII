import { describe, expect, it } from "vitest";

import { advanceSubagentViewState } from "./SubagentPipCard";

describe("advanceSubagentViewState", () => {
  it("preserves navigation for the same monitored session set", () => {
    const state = {
      sessionKeySignature: "a,b",
      pageIndex: 2,
      gridExpanded: true,
      expandedSessionId: "session-a",
    };
    expect(advanceSubagentViewState(state, "a,b")).toBe(state);
  });

  it("resets sticky navigation when the monitored session set changes", () => {
    expect(
      advanceSubagentViewState(
        {
          sessionKeySignature: "a,b",
          pageIndex: 2,
          gridExpanded: true,
          expandedSessionId: "session-a",
        },
        "c,d"
      )
    ).toEqual({
      sessionKeySignature: "c,d",
      pageIndex: 0,
      gridExpanded: false,
      expandedSessionId: null,
    });
  });
});
