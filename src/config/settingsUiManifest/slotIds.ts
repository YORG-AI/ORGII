export const SETTINGS_SECTION_SLOT_IDS = {
  APP_GENERAL: "app.general",
  APP_COLLABORATION: "app.collaboration",
  APP_APPEARANCE: "app.appearance",
  APP_EDITOR: "app.editor",
  APP_SECURITY: "app.security",

  APP_MONITOR: "app.monitor",

  AGENT_OS_CONFIG: "agent.osAgentConfig",
  AGENT_SDE_CONFIG: "agent.sdeAgentConfig",
} as const;

export type SettingsSectionSlotId =
  (typeof SETTINGS_SECTION_SLOT_IDS)[keyof typeof SETTINGS_SECTION_SLOT_IDS];

/**
 * Row slot ids — kept for the renderer's row dispatch even when empty.
 * Add an entry when a settings row needs to render a fully custom React
 * component (instead of a schema-driven control).
 */
export const SETTINGS_ROW_SLOT_IDS = {} as const;

export type SettingsRowSlotId =
  (typeof SETTINGS_ROW_SLOT_IDS)[keyof typeof SETTINGS_ROW_SLOT_IDS];
