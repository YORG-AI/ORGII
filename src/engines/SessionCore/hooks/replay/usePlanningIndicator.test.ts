import { describe, expect, it } from "vitest";

import { shouldShowPlanningIndicator } from "./usePlanningIndicator";

const baseInput = {
  runtimeStatus: "running",
  isSessionActive: true,
  isPendingCancel: false,
  hasAwaitingUserInteraction: false,
  anyRunning: false,
  coldStartVisible: false,
  idleAfterVersion: 10,
  version: 10,
  hasLiveSubagent: false,
  hasRunningAwaitWaitFor: false,
};

describe("shouldShowPlanningIndicator", () => {
  it("shows while the runtime is active and idle at the current version", () => {
    expect(shouldShowPlanningIndicator(baseInput)).toBe(true);
  });

  it("hides after Stop when runtime status is idle even if event state is stale", () => {
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        runtimeStatus: "idle",
        isSessionActive: false,
      })
    ).toBe(false);
  });

  it("hides while a Stop is pending", () => {
    expect(
      shouldShowPlanningIndicator({ ...baseInput, isPendingCancel: true })
    ).toBe(false);
  });

  it("stays visible after a settled assistant reply while the turn is still running", () => {
    expect(shouldShowPlanningIndicator(baseInput)).toBe(true);
  });

  it("shows when non-visible running events exist but no visible running row is painted", () => {
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        anyRunning: false,
      })
    ).toBe(true);
  });

  it("shows while a running tool row is idle long enough", () => {
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        anyRunning: true,
      })
    ).toBe(true);
  });

  it("shows during the parent gap when a background subagent is still running", () => {
    // Parent turn mechanically ended (runtimeStatus idle) but a
    // background subagent keeps the session alive — footer must stay up.
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        runtimeStatus: "idle",
        hasLiveSubagent: true,
      })
    ).toBe(true);
  });

  it("shows on a live subagent after a running row becomes idle", () => {
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        runtimeStatus: "idle",
        hasLiveSubagent: true,
        anyRunning: true,
      })
    ).toBe(true);
  });

  it("hides while a running await_output shows its own loading title", () => {
    // Any await_output (wait_for or monitor) renders a live shimmer title, so
    // the planning footer would be a redundant second activity indicator.
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        hasRunningAwaitWaitFor: true,
      })
    ).toBe(false);
  });

  it("still hides the footer during await_output even if a subagent is live", () => {
    expect(
      shouldShowPlanningIndicator({
        ...baseInput,
        runtimeStatus: "idle",
        hasLiveSubagent: true,
        hasRunningAwaitWaitFor: true,
      })
    ).toBe(false);
  });
});
