import { describe, expect, it } from "vitest";

import { ratePerMinuteInWindow, spansRepeatedActivity } from "../hotspotRates";

describe("hotspot rate helpers", () => {
  it("normalizes a batch against the displayed two-minute window", () => {
    expect(ratePerMinuteInWindow(10, 120_000)).toBe(5);
    expect(ratePerMinuteInWindow(1, 120_000)).toBe(0.5);
  });

  it("does not classify a near-simultaneous provider fan-out as polling", () => {
    expect(spansRepeatedActivity(10_000, 10_002)).toBe(false);
    expect(spansRepeatedActivity(10_000, 11_000)).toBe(true);
  });
});
