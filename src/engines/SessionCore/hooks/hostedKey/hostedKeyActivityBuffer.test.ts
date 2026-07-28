import { describe, expect, it } from "vitest";

import { hostedKeyActivityBufferTestApi } from "./useHostedKeyActivitySync";

describe("hosted-key activity buffer bounds", () => {
  const { limits, wouldOverflow } = hostedKeyActivityBufferTestApi;

  it("accepts values at the boundary and rejects count, byte, and item overflow", () => {
    expect(wouldOverflow(limits.events - 1, limits.bytes - 1, 1)).toBe(false);
    expect(wouldOverflow(limits.events, 0, 1)).toBe(true);
    expect(wouldOverflow(0, limits.bytes, 1)).toBe(true);
    expect(wouldOverflow(0, 0, limits.singleEventBytes + 1)).toBe(true);
  });
});
