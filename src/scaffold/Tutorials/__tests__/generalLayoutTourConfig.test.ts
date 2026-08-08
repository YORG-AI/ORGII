import { describe, expect, it } from "vitest";

import {
  GENERAL_LAYOUT_TOUR_STEPS,
  GENERAL_LAYOUT_TOUR_TARGETS,
} from "../generalLayoutTourConfig";

describe("general layout tour config", () => {
  it("introduces Runtime as the second independently targeted step", () => {
    expect(GENERAL_LAYOUT_TOUR_STEPS[1]).toEqual({
      id: "runtime",
      target: GENERAL_LAYOUT_TOUR_TARGETS.runtimeNavigation,
    });
    expect(
      GENERAL_LAYOUT_TOUR_STEPS.filter(
        (step) => step.target === GENERAL_LAYOUT_TOUR_TARGETS.runtimeNavigation
      )
    ).toHaveLength(1);
  });
});
