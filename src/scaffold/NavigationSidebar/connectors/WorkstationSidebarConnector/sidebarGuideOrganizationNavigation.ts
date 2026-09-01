import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import {
  CHAT_PANEL_COLLAB_ORG_MODE,
  CHAT_PANEL_COLLAB_ORG_SOURCE,
  type ChatPanelCollabOrgCreateIntent,
} from "@src/store/ui/chatPanelAtom";

interface SidebarGuideOrganizationNavigation {
  createIntent: ChatPanelCollabOrgCreateIntent;
  spotlight: {
    targetId: typeof GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT;
    messageKey: "sidebar.guide.createOrganizationHint";
  };
}

/** Build the one-shot form preset and delayed spotlight for the guide action. */
export function resolveSidebarGuideOrganizationNavigation(
  requestId: number
): SidebarGuideOrganizationNavigation {
  return {
    createIntent: {
      requestId,
      source: CHAT_PANEL_COLLAB_ORG_SOURCE.CLOUD,
      mode: CHAT_PANEL_COLLAB_ORG_MODE.CREATE,
    },
    spotlight: {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      messageKey: "sidebar.guide.createOrganizationHint",
    },
  };
}
