import { describe, expect, it } from "vitest";

import { shouldShowNativeSurface } from "./nativeSurfaceVisibility";

describe("shouldShowNativeSurface", () => {
  it("keeps a successfully loaded GitHub-like page visible after a timed host hint", () => {
    expect(
      shouldShowNativeSurface({
        isLoading: false,
        hasConfirmedError: false,
        hasTimedSensitiveHostHint: true,
      })
    ).toBe(true);
  });

  it.each([
    { isLoading: true, hasConfirmedError: false },
    { isLoading: false, hasConfirmedError: true },
  ])("hides the surface for real blocking state: %o", (state) => {
    expect(
      shouldShowNativeSurface({
        ...state,
        hasTimedSensitiveHostHint: false,
      })
    ).toBe(false);
  });
});
