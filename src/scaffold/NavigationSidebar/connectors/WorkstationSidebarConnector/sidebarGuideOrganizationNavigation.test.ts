import { describe, expect, it } from "vitest";

import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { resolveSidebarGuideOrganizationNavigation } from "./sidebarGuideOrganizationNavigation";

describe("resolveSidebarGuideOrganizationNavigation", () => {
  it("requests cloud creation and targets the organization name field", () => {
    expect(resolveSidebarGuideOrganizationNavigation()).toEqual({
      context: {
        source: "cloud",
        mode: "create",
      },
      spotlight: {
        targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
        messageKey: "sidebar.guide.createOrganizationHint",
      },
    });
  });
});
