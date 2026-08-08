import { describe, expect, it } from "vitest";

import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import {
  CHAT_PANEL_COLLAB_ORG_MODE,
  CHAT_PANEL_COLLAB_ORG_SOURCE,
} from "@src/store/ui/chatPanelAtom";

import { resolveSidebarGuideOrganizationNavigation } from "./sidebarGuideOrganizationNavigation";

describe("resolveSidebarGuideOrganizationNavigation", () => {
  it("requests cloud creation and targets the organization name field", () => {
    expect(resolveSidebarGuideOrganizationNavigation(42)).toEqual({
      createIntent: {
        requestId: 42,
        source: CHAT_PANEL_COLLAB_ORG_SOURCE.CLOUD,
        mode: CHAT_PANEL_COLLAB_ORG_MODE.CREATE,
      },
      spotlight: {
        targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
        messageKey: "sidebar.guide.createOrganizationHint",
      },
    });
  });
});
