export const SIDEBAR_GUIDE_MILESTONE = {
  SESSION: "session",
  ORGANIZATION: "organization",
  TEAMMATE: "teammate",
  TEAM_USAGE: "team_usage",
  PRODUCT_TOUR: "product_tour",
} as const;

export type SidebarGuideMilestone =
  (typeof SIDEBAR_GUIDE_MILESTONE)[keyof typeof SIDEBAR_GUIDE_MILESTONE];

export type SidebarGuideCompletion = Record<SidebarGuideMilestone, boolean>;

const MILESTONE_ORDER: readonly SidebarGuideMilestone[] = [
  SIDEBAR_GUIDE_MILESTONE.SESSION,
  SIDEBAR_GUIDE_MILESTONE.ORGANIZATION,
  SIDEBAR_GUIDE_MILESTONE.TEAMMATE,
  SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE,
  SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR,
];

export function getNextSidebarGuideMilestone(
  completion: SidebarGuideCompletion
): SidebarGuideMilestone | null {
  return MILESTONE_ORDER.find((milestone) => !completion[milestone]) ?? null;
}
