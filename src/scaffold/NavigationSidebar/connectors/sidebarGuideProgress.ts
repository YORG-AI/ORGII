export const SIDEBAR_GUIDE_MILESTONE = {
  SESSION: "session",
  TEAM: "team",
  WORK: "work",
} as const;

export type SidebarGuideMilestone =
  (typeof SIDEBAR_GUIDE_MILESTONE)[keyof typeof SIDEBAR_GUIDE_MILESTONE];

export type SidebarGuideCompletion = Record<SidebarGuideMilestone, boolean>;

export interface SidebarGuideProgress {
  completedCount: number;
  totalCount: number;
  percent: number;
  nextMilestone: SidebarGuideMilestone | null;
}

const MILESTONE_ORDER: readonly SidebarGuideMilestone[] = [
  SIDEBAR_GUIDE_MILESTONE.SESSION,
  SIDEBAR_GUIDE_MILESTONE.TEAM,
  SIDEBAR_GUIDE_MILESTONE.WORK,
];

export function getSidebarGuideProgress(
  completion: SidebarGuideCompletion
): SidebarGuideProgress {
  const completedCount = MILESTONE_ORDER.filter(
    (milestone) => completion[milestone]
  ).length;
  const totalCount = MILESTONE_ORDER.length;

  return {
    completedCount,
    totalCount,
    percent: Math.round((completedCount / totalCount) * 100),
    nextMilestone:
      MILESTONE_ORDER.find((milestone) => !completion[milestone]) ?? null,
  };
}
