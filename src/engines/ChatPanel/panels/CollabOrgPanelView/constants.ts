export const COLLAB_ORG_TAB = {
  WORK_ITEMS: "workItems",
  PROJECTS: "projects",
  SESSIONS: "sessions",
  MEMBERS: "members",
  CHAT: "chat",
  SETTINGS: "settings",
} as const;

export type CollabOrgTab = (typeof COLLAB_ORG_TAB)[keyof typeof COLLAB_ORG_TAB];

export const CHAT_HISTORY_LIMIT = 100;
export const DEFAULT_INVITE_USAGE_LIMIT = 10;

export const COLLAB_SNAPSHOT_REQUEST_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  DENIED: "denied",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
