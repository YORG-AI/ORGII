import { describe, expect, it } from "vitest";

import { shouldInterruptTimelineBoundary } from "../sessionTimelineBoundaryHelpers";

describe("shouldInterruptTimelineBoundary", () => {
  it("always interrupts stop and force-send", () => {
    const idle = { turnActive: false, hasLiveSubagents: false };
    expect(shouldInterruptTimelineBoundary("stop", idle)).toBe(true);
    expect(shouldInterruptTimelineBoundary("force-send", idle)).toBe(true);
  });

  it("skips an idle rewind", () => {
    expect(
      shouldInterruptTimelineBoundary("rewind", {
        turnActive: false,
        hasLiveSubagents: false,
      })
    ).toBe(false);
  });

  it("interrupts rewind for an active target turn or its live subagents", () => {
    expect(
      shouldInterruptTimelineBoundary("rewind", {
        turnActive: true,
        hasLiveSubagents: false,
      })
    ).toBe(true);
    expect(
      shouldInterruptTimelineBoundary("rewind", {
        turnActive: false,
        hasLiveSubagents: true,
      })
    ).toBe(true);
  });
});
