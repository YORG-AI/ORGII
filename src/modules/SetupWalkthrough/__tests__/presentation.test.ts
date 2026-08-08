import { describe, expect, it } from "vitest";

import {
  SETUP_WALKTHROUGH_PRESENTATION,
  normalizeSetupWalkthroughPresentation,
} from "../presentation";

describe("setup walkthrough presentation", () => {
  it.each([
    ["compact", SETUP_WALKTHROUGH_PRESENTATION.COMPACT],
    ["mascot", SETUP_WALKTHROUGH_PRESENTATION.MASCOT],
  ])("accepts the supported %s value", (value, expected) => {
    expect(normalizeSetupWalkthroughPresentation(value)).toBe(expected);
  });

  it.each([undefined, null, "", "cinematic", "classic", 1])(
    "falls back to compact for unsupported value %s",
    (value) => {
      expect(normalizeSetupWalkthroughPresentation(value)).toBe(
        SETUP_WALKTHROUGH_PRESENTATION.COMPACT
      );
    }
  );
});
