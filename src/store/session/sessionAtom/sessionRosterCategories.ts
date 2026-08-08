export const BASE_SESSION_LIST_CATEGORIES = [
  "pinned_native",
  "cli_agent",
  "standalone_agent",
  "agent_org_root",
  "os_agent",
  "human_session",
] as const;

export type BaseSessionListCategory =
  (typeof BASE_SESSION_LIST_CATEGORIES)[number];
