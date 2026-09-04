export const PROJECT_ADAPTER_TYPES = [
  { type: "github", labelKey: "gitConnections.github" },
  { type: "linear", labelKey: "projectConnections.linear" },
] as const;

export type ProjectSyncAdapterType =
  (typeof PROJECT_ADAPTER_TYPES)[number]["type"];

// Auth methods used by project connections. GitHub supports scan / OAuth /
// PAT / SSH; Linear supports OAuth / PAT.
const STORY_SYNC_AUTH_METHODS = {
  PAT: "pat",
  OAUTH: "oauth",
  SCAN: "scan",
  SSH: "ssh",
} as const;

export type ProjectSyncAuthMethod =
  (typeof STORY_SYNC_AUTH_METHODS)[keyof typeof STORY_SYNC_AUTH_METHODS];

export type WizardCategory = "channels" | "projects";
