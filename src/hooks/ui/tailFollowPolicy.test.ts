import { describe, expect, it } from "vitest";

import {
  getPhysicalDistanceFromBottom,
  getPhysicalScrollBottom,
  isWithinTailFollowThreshold,
} from "./tailFollowPolicy";

describe("tailFollowPolicy", () => {
  it("computes the physical bottom and distance", () => {
    expect(
      getPhysicalScrollBottom({ scrollHeight: 900, clientHeight: 300 })
    ).toBe(600);
    expect(
      getPhysicalDistanceFromBottom({
        scrollTop: 520,
        scrollHeight: 900,
        clientHeight: 300,
      })
    ).toBe(80);
  });

  it("shares the ChatPanel 48px follow threshold", () => {
    expect(isWithinTailFollowThreshold(48)).toBe(true);
    expect(isWithinTailFollowThreshold(49)).toBe(false);
  });
});
