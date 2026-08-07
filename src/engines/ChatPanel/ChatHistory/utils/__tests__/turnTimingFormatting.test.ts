import { describe, expect, it } from "vitest";

import {
  formatTurnDuration,
  getTurnTimingLabels,
} from "../turnTimingFormatting";

describe("formatTurnDuration", () => {
  it("uses the same compact spoken-duration format as the turn sidebar", () => {
    expect(formatTurnDuration(42_000)).toBe("42s");
    expect(formatTurnDuration(5 * 60_000)).toBe("5m");
    expect(formatTurnDuration(5 * 60_000 + 5_000)).toBe("5m 5s");
  });

  it("normalizes missing and invalid durations to <1min", () => {
    expect(formatTurnDuration(0)).toBe("<1min");
    expect(formatTurnDuration(Number.NaN)).toBe("<1min");
    // Sub-second real durations round to 0s, which reads as broken too.
    expect(formatTurnDuration(400)).toBe("<1min");
  });
});

describe("getTurnTimingLabels", () => {
  const startMs = Date.UTC(2026, 6, 13, 9, 0, 0);

  it("shows a clock range when both endpoints are at least one second apart", () => {
    const timing = getTurnTimingLabels(65_000, startMs, startMs + 65_000);

    expect(timing.duration).toBe("1m 5s");
    expect(timing.startClock).not.toBe("");
    expect(timing.endClock).not.toBe("");
    expect(timing.showRange).toBe(true);
  });

  it("suppresses noisy or incomplete clock ranges", () => {
    expect(getTurnTimingLabels(500, startMs, startMs + 500).showRange).toBe(
      false
    );
    expect(getTurnTimingLabels(1_000, startMs, null).showRange).toBe(false);
  });
});
