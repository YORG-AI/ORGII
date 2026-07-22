import { describe, expect, it } from "vitest";

import { ReplayRequestGuard } from "./replayRequestGuard";

describe("ReplayRequestGuard", () => {
  it("rejects an older request after a newer request starts", () => {
    const guard = new ReplayRequestGuard();
    const older = guard.begin();
    const newer = guard.begin();

    expect(guard.isCurrent(older)).toBe(false);
    expect(guard.isCurrent(newer)).toBe(true);
  });

  it("rejects an in-flight request when the component episode changes", () => {
    const guard = new ReplayRequestGuard();
    const inFlight = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(inFlight)).toBe(false);
  });
});
