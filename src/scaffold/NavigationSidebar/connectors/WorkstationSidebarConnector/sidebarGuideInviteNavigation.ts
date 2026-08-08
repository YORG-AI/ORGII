import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

export interface SidebarGuideInviteSpotlight {
  targetId: string;
  messageKey:
    | "sidebar.guide.inviteTeammateHint"
    | "sidebar.guide.invitePermissionHint";
}

export function resolveSidebarGuideInviteSpotlight(
  role: string | null | undefined
): SidebarGuideInviteSpotlight {
  if (role === "admin" || role === "owner") {
    return {
      targetId: GUIDE_TARGETS.CLOUD_ORG_INVITE_ACTION,
      messageKey: "sidebar.guide.inviteTeammateHint",
    };
  }

  return {
    targetId: GUIDE_TARGETS.CLOUD_ORG_MEMBERS_SECTION,
    messageKey: "sidebar.guide.invitePermissionHint",
  };
}
