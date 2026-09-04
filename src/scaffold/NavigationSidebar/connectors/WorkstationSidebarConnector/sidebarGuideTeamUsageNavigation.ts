import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import type { RuntimeOrganizationNavigationIntent } from "@src/store/ui/runtimeNavigationAtom";

interface SidebarGuideTeamUsageNavigation {
  intent: RuntimeOrganizationNavigationIntent;
  spotlight: {
    targetId: typeof GUIDE_TARGETS.TEAM_RUNTIME_TABS;
    messageKey: "sidebar.guide.viewTeamActivityHint";
  };
}

/** Open Runtime at the selected organization's member-usage entry point. */
export function resolveSidebarGuideTeamUsageNavigation(
  requestId: number,
  orgId: string | null | undefined
): SidebarGuideTeamUsageNavigation | null {
  if (!orgId) return null;
  return {
    intent: {
      requestId,
      scope: "organization",
      orgId,
      view: "members",
    },
    spotlight: {
      targetId: GUIDE_TARGETS.TEAM_RUNTIME_TABS,
      messageKey: "sidebar.guide.viewTeamActivityHint",
    },
  };
}
