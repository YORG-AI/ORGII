export type CloudOrgManagementTab = "general" | "members";

export const CLOUD_ORG_MANAGEMENT_TAB = {
  GENERAL: "general",
  MEMBERS: "members",
} as const satisfies Record<string, CloudOrgManagementTab>;

export type SelectValue = string | number | (string | number)[];
