import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import type { SpotlightCollabOrgContext } from "@src/store/ui/uiAtom";

interface SidebarGuideOrganizationNavigation {
  context: SpotlightCollabOrgContext;
  spotlight: {
    targetId: typeof GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT;
    messageKey: "sidebar.guide.createOrganizationHint";
  };
}

/** Build the one-shot form preset and delayed spotlight for the guide action. */
export function resolveSidebarGuideOrganizationNavigation(): SidebarGuideOrganizationNavigation {
  return {
    context: {
      source: "cloud",
      mode: "create",
    },
    spotlight: {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      messageKey: "sidebar.guide.createOrganizationHint",
    },
  };
}
