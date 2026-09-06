export const SETTINGS_SECTION_SLOT_IDS = {
  APP_GENERAL: "app.general",
  APP_APPEARANCE: "app.appearance",
  APP_EDITOR: "app.editor",
  APP_SECURITY: "app.security",
  APP_MOBILE_REMOTE: "app.mobileRemote",

  APP_HARNESS_CONNECTIONS: "app.harnessConnections",
  APP_MONITOR: "app.monitor",

  AGENT_OS_CONFIG: "agent.osAgentConfig",
  AGENT_SDE_CONFIG: "agent.sdeAgentConfig",
} as const;

export type SettingsSectionSlotId =
  (typeof SETTINGS_SECTION_SLOT_IDS)[keyof typeof SETTINGS_SECTION_SLOT_IDS];
