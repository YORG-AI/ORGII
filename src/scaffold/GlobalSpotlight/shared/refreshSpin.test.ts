import { describe, expect, it } from "vitest";

import { REFRESH_SPIN_MIN_MS, remainingSpinMs } from "./refreshSpin";

describe("remainingSpinMs", () => {
  it("pads a refresh that resolved faster than the minimum spin", () => {
    expect(remainingSpinMs(0)).toBe(REFRESH_SPIN_MIN_MS);
    expect(remainingSpinMs(200)).toBe(REFRESH_SPIN_MIN_MS - 200);
  });

  it("stops immediately once the refresh outlasted the minimum spin", () => {
    expect(remainingSpinMs(REFRESH_SPIN_MIN_MS)).toBe(0);
    expect(remainingSpinMs(REFRESH_SPIN_MIN_MS + 5_000)).toBe(0);
  });

  it("treats a non-monotonic or invalid clock delta as no remaining spin", () => {
    expect(remainingSpinMs(-50)).toBe(REFRESH_SPIN_MIN_MS);
    expect(remainingSpinMs(Number.NaN)).toBe(0);
  });
});
