import { describe, expect, it } from "vitest";

import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { resolveSidebarGuideInviteSpotlight } from "./sidebarGuideInviteNavigation";

describe("resolveSidebarGuideInviteSpotlight", () => {
  it.each(["admin", "owner"])(
    "targets the invite action for the %s role",
    (role) => {
      expect(resolveSidebarGuideInviteSpotlight(role)).toEqual({
        targetId: GUIDE_TARGETS.CLOUD_ORG_INVITE_ACTION,
        messageKey: "sidebar.guide.inviteTeammateHint",
      });
    }
  );

  it.each(["member", "viewer", null, undefined])(
    "targets the readable members section for a non-manager role (%s)",
    (role) => {
      expect(resolveSidebarGuideInviteSpotlight(role)).toEqual({
        targetId: GUIDE_TARGETS.CLOUD_ORG_MEMBERS_SECTION,
        messageKey: "sidebar.guide.invitePermissionHint",
      });
    }
  );
});
