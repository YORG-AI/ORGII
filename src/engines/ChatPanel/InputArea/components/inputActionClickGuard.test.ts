import { describe, expect, it } from "vitest";

import { shouldSuppressOppositeInputAction } from "./inputActionClickGuard";

describe("shouldSuppressOppositeInputAction", () => {
  it("blocks a Stop click that lands immediately after Send changes state", () => {
    expect(
      shouldSuppressOppositeInputAction(
        { action: "submit", at: 1_000 },
        "stop",
        1_143
      )
    ).toBe(true);
  });

  it("allows Stop after the gesture guard expires", () => {
    expect(
      shouldSuppressOppositeInputAction(
        { action: "submit", at: 1_000 },
        "stop",
        1_700
      )
    ).toBe(false);
  });

  it("does not block repeated actions with the same meaning", () => {
    expect(
      shouldSuppressOppositeInputAction(
        { action: "stop", at: 1_000 },
        "stop",
        1_100
      )
    ).toBe(false);
  });
});
