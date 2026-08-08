import {
  SETUP_GUIDE_PERSISTED_MILESTONES,
  type SetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";

export type SetupGuidePersistedMilestone =
  (typeof SETUP_GUIDE_PERSISTED_MILESTONES)[number];

export const SETUP_GUIDE_PERSISTED_MILESTONE = {
  TEAMMATE_INVITED: "teammate_invited",
  PRODUCT_TOUR_STARTED: "product_tour_started",
  /** Reused from the original team-activity task for v1 compatibility. */
  TEAM_ACTIVITY_VIEWED: "team_activity_viewed",
} as const satisfies Record<string, SetupGuidePersistedMilestone>;

/** Arm the one-time handoff only for users who have not seen it before. */
export function requestSetupGuideHandoff(
  progress: SetupWalkthroughProgress
): SetupWalkthroughProgress {
  if (progress.guideHandoff !== "idle") return progress;
  return { ...progress, guideHandoff: "pending" };
}

/** Persist that the pending handoff has been displayed. */
export function consumeSetupGuideHandoff(
  progress: SetupWalkthroughProgress
): SetupWalkthroughProgress {
  if (progress.guideHandoff !== "pending") return progress;
  return { ...progress, guideHandoff: "shown" };
}

export function completeSetupGuideMilestone(
  progress: SetupWalkthroughProgress,
  milestone: SetupGuidePersistedMilestone
): SetupWalkthroughProgress {
  if (progress.guideCompletedMilestones.includes(milestone)) return progress;
  return {
    ...progress,
    guideCompletedMilestones: [...progress.guideCompletedMilestones, milestone],
  };
}

export function hasCompletedSetupGuideMilestone(
  progress: SetupWalkthroughProgress,
  milestone: SetupGuidePersistedMilestone
): boolean {
  return progress.guideCompletedMilestones.includes(milestone);
}
