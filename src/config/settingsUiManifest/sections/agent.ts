import { SETTINGS_SECTION_SLOT_IDS } from "@src/config/settingsUiManifest/slotIds";
import type { SettingsSectionDefinition } from "@src/config/settingsUiManifest/types";
import { CodeIcon, RecordIcon } from "@src/icons";

/**
 * Agent settings sections.
 *
 * These sections render via custom slots (`AgentOSConfigSection`,
 * `AgentSdeConfigSection`, `AgentCapabilitiesSection`) and write directly
 * to the backend `AgentDefinition` store (S3) — they do NOT mirror anything
 * into `settings.jsonc` (S1). See `agentConfigSync` retirement and the
 * P0-10 audit entry for the rationale.
 *
 * `coveredKeys` is therefore intentionally empty: there are no
 * schema-backed `agent.os.*` / `agent.sde.*` keys for the parity check
 * to bind to.
 */
export const AGENT_SETTINGS_UI_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "os-agent-config",
    tab: "agent",
    labelKey: "osAgentConfig",
    headingTitleKey: "sections.osAgentConfig",
    icon: RecordIcon,
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.AGENT_OS_CONFIG,
    coveredKeys: [],
  },
  {
    id: "sde-agent-config",
    tab: "agent",
    labelKey: "sdeAgentConfig",
    headingTitleKey: "sections.sdeAgentConfig",
    icon: CodeIcon,
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.AGENT_SDE_CONFIG,
    coveredKeys: [],
  },
];
