import { describe, expect, it } from "vitest";

import {
  SETUP_WALKTHROUGH_OUTCOME_KEY,
  resolveSetupWalkthroughOutcome,
  shouldSignalGitHubStarAfterSetup,
} from "./setupWalkthrough";

describe("setup walkthrough outcome migration", () => {
  it("keeps a new empty install open", () => {
    expect(resolveSetupWalkthroughOutcome({})).toBe("open");
    expect(
      resolveSetupWalkthroughOutcome({ $schema: "settings.schema.json" })
    ).toBe("open");
  });

  it("does not interrupt existing installs that predate onboarding state", () => {
    expect(
      resolveSetupWalkthroughOutcome({ "general.theme": "github-dark" })
    ).toBe("completed");
  });

  it("migrates the temporary completion boolean", () => {
    expect(
      resolveSetupWalkthroughOutcome({
        "general.setupWalkthroughCompleted": false,
      })
    ).toBe("open");
    expect(
      resolveSetupWalkthroughOutcome({
        "general.setupWalkthroughCompleted": true,
      })
    ).toBe("completed");
  });

  it("signals the Star value moment only after completion", () => {
    expect(shouldSignalGitHubStarAfterSetup("completed")).toBe(true);
    expect(shouldSignalGitHubStarAfterSetup("dismissed")).toBe(false);
  });

  it("preserves every explicit outcome", () => {
    for (const outcome of ["open", "completed", "dismissed"] as const) {
      expect(
        resolveSetupWalkthroughOutcome({
          [SETUP_WALKTHROUGH_OUTCOME_KEY]: outcome,
          "general.setupWalkthroughCompleted": outcome !== "open",
        })
      ).toBe(outcome);
    }
  });
});
