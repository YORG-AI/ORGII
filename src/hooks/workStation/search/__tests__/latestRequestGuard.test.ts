import { describe, expect, it } from "vitest";

import { LatestRequestGuard } from "../latestRequestGuard";

describe("LatestRequestGuard", () => {
  it("allows only the newest issued request to commit", () => {
    const guard = new LatestRequestGuard();
    const first = guard.issue();
    const second = guard.issue();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("invalidates an in-flight request when search is cleared", () => {
    const guard = new LatestRequestGuard();
    const request = guard.issue();

    guard.invalidate();

    expect(guard.isCurrent(request)).toBe(false);
  });
});
