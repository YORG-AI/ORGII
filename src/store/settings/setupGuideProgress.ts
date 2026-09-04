import {
  SIDEBAR_GUIDE_PERSISTED_MILESTONES,
  type SidebarGuideProgress,
} from "@src/config/settingsSchema/sidebarGuideProgress";

export type SetupGuidePersistedMilestone =
  (typeof SIDEBAR_GUIDE_PERSISTED_MILESTONES)[number];

export const SETUP_GUIDE_PERSISTED_MILESTONE = {
  TEAMMATE_INVITED: "teammate_invited",
  PRODUCT_TOUR_STARTED: "product_tour_started",
  /** Reused from the original team-activity task for v1 compatibility. */
  TEAM_ACTIVITY_VIEWED: "team_activity_viewed",
} as const satisfies Record<string, SetupGuidePersistedMilestone>;

export function completeSetupGuideMilestone(
  progress: SidebarGuideProgress,
  milestone: SetupGuidePersistedMilestone
): SidebarGuideProgress {
  if (progress.guideCompletedMilestones.includes(milestone)) return progress;
  return {
    ...progress,
    guideCompletedMilestones: [...progress.guideCompletedMilestones, milestone],
  };
}

export function dismissSetupGuide(
  progress: SidebarGuideProgress
): SidebarGuideProgress {
  if (progress.dismissed) return progress;
  return { ...progress, dismissed: true };
}

export function hasCompletedSetupGuideMilestone(
  progress: SidebarGuideProgress,
  milestone: SetupGuidePersistedMilestone
): boolean {
  return progress.guideCompletedMilestones.includes(milestone);
}
