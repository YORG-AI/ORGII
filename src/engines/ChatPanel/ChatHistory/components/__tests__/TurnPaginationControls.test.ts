import { describe, expect, it } from "vitest";

import { shouldShowTurnPaginationSpinner } from "../TurnPaginationControls";

describe("shouldShowTurnPaginationSpinner", () => {
  it("does not animate a stable empty session", () => {
    expect(
      shouldShowTurnPaginationSpinner({
        turnPaginationReady: false,
        pageCount: 0,
      })
    ).toBe(false);
  });

  it("animates while an existing round is still hydrating", () => {
    expect(
      shouldShowTurnPaginationSpinner({
        turnPaginationReady: false,
        pageCount: 1,
      })
    ).toBe(true);
  });

  it("stops once the current round is ready", () => {
    expect(
      shouldShowTurnPaginationSpinner({
        turnPaginationReady: true,
        pageCount: 1,
      })
    ).toBe(false);
  });
});
