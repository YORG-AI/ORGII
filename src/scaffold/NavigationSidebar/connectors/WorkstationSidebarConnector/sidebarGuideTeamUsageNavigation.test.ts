import { describe, expect, it } from "vitest";

import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { resolveSidebarGuideTeamUsageNavigation } from "./sidebarGuideTeamUsageNavigation";

describe("resolveSidebarGuideTeamUsageNavigation", () => {
  it("opens the requested organization on Runtime members and targets its tabs", () => {
    expect(resolveSidebarGuideTeamUsageNavigation(42, "org-1")).toEqual({
      intent: {
        requestId: 42,
        scope: "organization",
        orgId: "org-1",
        view: "members",
      },
      spotlight: {
        targetId: GUIDE_TARGETS.TEAM_RUNTIME_TABS,
        messageKey: "sidebar.guide.viewTeamActivityHint",
      },
    });
  });

  it("does not create a Runtime intent without a cloud organization", () => {
    expect(resolveSidebarGuideTeamUsageNavigation(42, null)).toBeNull();
  });
});
