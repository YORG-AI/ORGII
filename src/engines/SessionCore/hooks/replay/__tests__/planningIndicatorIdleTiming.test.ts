import { describe, expect, it } from "vitest";

import {
  PLANNING_IDLE_THRESHOLD_MS,
  planningIdleTimingReducer,
} from "../planningIndicatorIdleTiming";

describe("planningIdleTimingReducer", () => {
  it("clears activation and idle trackers when session becomes inactive", () => {
    const next = planningIdleTimingReducer(
      { activationVersion: 3, idleAfterVersion: 3 },
      { type: "session_inactive" }
    );
    expect(next).toEqual({ activationVersion: null, idleAfterVersion: null });
  });
});

describe("PLANNING_IDLE_THRESHOLD_MS", () => {
  it("matches the planning footer debounce contract", () => {
    expect(PLANNING_IDLE_THRESHOLD_MS).toBe(1000);
  });
});
