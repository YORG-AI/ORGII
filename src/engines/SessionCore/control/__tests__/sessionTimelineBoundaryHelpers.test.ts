import { describe, expect, it } from "vitest";

import {
  resolveShouldInterruptForTimelineBoundary,
  shouldInterruptRewindBoundary,
} from "../sessionTimelineBoundaryHelpers";

describe("shouldInterruptRewindBoundary", () => {
  it("returns false when the session turn is idle and no subagents are live", () => {
    expect(
      shouldInterruptRewindBoundary({
        turnActive: false,
        hasLiveSubagents: false,
      })
    ).toBe(false);
  });

  it("returns true when the session turn FSM is non-idle", () => {
    expect(
      shouldInterruptRewindBoundary({
        turnActive: true,
        hasLiveSubagents: false,
      })
    ).toBe(true);
  });

  it("returns true when the session still has live background subagents", () => {
    expect(
      shouldInterruptRewindBoundary({
        turnActive: false,
        hasLiveSubagents: true,
      })
    ).toBe(true);
  });
});

describe("resolveShouldInterruptForTimelineBoundary", () => {
  it("always interrupts for stop and force-send regardless of session signals", () => {
    const idle = { turnActive: false, hasLiveSubagents: false };
    expect(resolveShouldInterruptForTimelineBoundary("stop", idle)).toBe(true);
    expect(resolveShouldInterruptForTimelineBoundary("force-send", idle)).toBe(
      true
    );
  });

  it("delegates rewind to session-scoped signals", () => {
    const idle = { turnActive: false, hasLiveSubagents: false };
    const active = { turnActive: true, hasLiveSubagents: false };

    expect(resolveShouldInterruptForTimelineBoundary("rewind", idle)).toBe(
      false
    );
    expect(resolveShouldInterruptForTimelineBoundary("rewind", active)).toBe(
      true
    );
  });

  it("does not interrupt rewind when only a different session is active", () => {
    // Foreground session activity must not bleed into a background rewind.
    expect(
      resolveShouldInterruptForTimelineBoundary("rewind", {
        turnActive: false,
        hasLiveSubagents: false,
      })
    ).toBe(false);
  });
});
