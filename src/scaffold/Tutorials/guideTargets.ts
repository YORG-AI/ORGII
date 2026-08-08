export const GUIDE_TARGETS = {
  APP_ROOT: "app.root",
  SIDEBAR: "app.sidebar",
  WORKSTATION: "workstation.surface",
  WORKSTATION_TAB_BAR: "workstation.tabBar",
  WORKSTATION_TAB_HEADER: "workstation.tabHeader",
  WORKSTATION_DOCK: "workstation.dock",
  CHAT_PANEL: "chatPanel.surface",
  COLLAB_ORG_NAME_INPUT: "collabOrg.nameInput",
  CLOUD_ORG_INVITE_ACTION: "cloudOrg.inviteAction",
  CLOUD_ORG_MEMBERS_SECTION: "cloudOrg.membersSection",
  TEAM_RUNTIME_TABS: "teamRuntime.tabs",
  ADE_MANAGER_COMPOSER: "adeManager.composer",
  TUTORIALS_MODAL: "tutorials.modal",
} as const;

export type GuideTargetId = (typeof GUIDE_TARGETS)[keyof typeof GUIDE_TARGETS];
