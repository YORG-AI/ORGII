import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIDEBAR_GUIDE_PROGRESS,
  normalizeSidebarGuideProgress,
} from "@src/config/settingsSchema/sidebarGuideProgress";

import {
  SETUP_GUIDE_PERSISTED_MILESTONE,
  completeSetupGuideMilestone,
  dismissSetupGuide,
  hasCompletedSetupGuideMilestone,
} from "./setupGuideProgress";

describe("setup guide progress", () => {
  it("preserves completed milestones from the retired walkthrough state", () => {
    const legacy = {
      version: 1,
      goal: "personal",
      currentStepId: "ready",
      guideHandoff: "shown",
      guideCompletedMilestones: ["team_activity_viewed"],
    };

    expect(normalizeSidebarGuideProgress(legacy)).toEqual({
      version: 1,
      dismissed: false,
      guideCompletedMilestones: ["team_activity_viewed"],
    });
  });

  it("defaults older walkthrough state without guide milestones", () => {
    expect(
      normalizeSidebarGuideProgress({ version: 1, currentStepId: "goal" })
    ).toEqual(DEFAULT_SIDEBAR_GUIDE_PROGRESS);
  });

  it("records explicit product actions idempotently", () => {
    const completed = completeSetupGuideMilestone(
      DEFAULT_SIDEBAR_GUIDE_PROGRESS,
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

  it("dismisses the guide idempotently", () => {
    const dismissed = dismissSetupGuide(DEFAULT_SIDEBAR_GUIDE_PROGRESS);

    expect(dismissed.dismissed).toBe(true);
    expect(dismissSetupGuide(dismissed)).toBe(dismissed);
  });
});
