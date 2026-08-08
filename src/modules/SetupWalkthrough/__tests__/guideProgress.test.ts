import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
  normalizeSetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";
import {
  SETUP_GUIDE_PERSISTED_MILESTONE,
  completeSetupGuideMilestone,
  consumeSetupGuideHandoff,
  hasCompletedSetupGuideMilestone,
  requestSetupGuideHandoff,
} from "@src/store/settings/setupGuideProgress";

describe("setup guide progress", () => {
  it("normalizes legacy progress with safe guide defaults", () => {
    const {
      guideHandoff: _handoff,
      guideCompletedMilestones: _milestones,
      ...legacy
    } = DEFAULT_SETUP_WALKTHROUGH_PROGRESS;

    expect(normalizeSetupWalkthroughProgress(legacy)).toEqual({
      ...legacy,
      guideHandoff: "idle",
      guideCompletedMilestones: [],
    });
  });

  it("arms and consumes the one-time post-setup handoff", () => {
    const pending = requestSetupGuideHandoff(
      DEFAULT_SETUP_WALKTHROUGH_PROGRESS
    );
    expect(pending.guideHandoff).toBe("pending");

    const shown = consumeSetupGuideHandoff(pending);
    expect(shown.guideHandoff).toBe("shown");
    expect(requestSetupGuideHandoff(shown)).toBe(shown);
  });

  it("records explicit product actions idempotently", () => {
    const completed = completeSetupGuideMilestone(
      DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      SETUP_GUIDE_PERSISTED_MILESTONE.TEAMMATE_INVITED
    );

    expect(
      hasCompletedSetupGuideMilestone(
        completed,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAMMATE_INVITED
      )
    ).toBe(true);
    expect(
      completeSetupGuideMilestone(
        completed,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAMMATE_INVITED
      )
    ).toBe(completed);
  });

  it("keeps legacy activity progress parseable while tracking the new product tour separately", () => {
    const legacy = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      guideCompletedMilestones: ["team_activity_viewed"],
    };

    expect(
      normalizeSetupWalkthroughProgress(legacy).guideCompletedMilestones
    ).toEqual(["team_activity_viewed"]);

    const completed = completeSetupGuideMilestone(
      normalizeSetupWalkthroughProgress(legacy),
      SETUP_GUIDE_PERSISTED_MILESTONE.PRODUCT_TOUR_STARTED
    );
    expect(completed.guideCompletedMilestones).toEqual([
      "team_activity_viewed",
      "product_tour_started",
    ]);
  });
});
