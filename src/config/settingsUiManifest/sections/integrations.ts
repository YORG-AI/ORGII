import { AppWindow, UserRoundCog } from "lucide-react";

import type { SettingsKey } from "@src/config/settingsSchema";
import { AGENT_BROWSER_SETTING_KEYS } from "@src/config/settingsSchema/registry/agentBrowser";
import type { SettingsSectionDefinition } from "@src/config/settingsUiManifest/types";

const MY_ROLE_SETTING_KEYS = [
  "agent.sde.questionAutoSkipTimeoutByPresence",
  "agent.sde.planAutoApproveTimeoutByPresence",
  "agent.sde.goalMaxTurnsByPresence",
  "agent.sde.modeSwitchAutoPlanByPresence",
  "general.presenceGuidanceOnline",
  "general.presenceGuidanceInvisible",
  "general.presenceGuidanceAway",
  "general.profileTechSavvy",
  "general.profileJobRoles",
  "general.profileFamiliarTechStacks",
  "general.profileDescription",
] as const satisfies readonly SettingsKey[];

export const INTEGRATIONS_SETTINGS_UI_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "models-my-roles",
    tab: "integrations",
    labelKey: "modelsTabs.myRoles",
    headingTitleKey: "modelsTabs.myRoles",
    icon: UserRoundCog,
    coveredKeys: [...MY_ROLE_SETTING_KEYS],
  },
  {
    id: "built-in-tools-computer-use",
    tab: "integrations",
    labelKey: "builtInTools.tabDesktopControl",
    headingTitleKey: "builtInTools.tabDesktopControl",
    icon: AppWindow,
    coveredKeys: [
      AGENT_BROWSER_SETTING_KEYS.PROVIDER,
      AGENT_BROWSER_SETTING_KEYS.AGENT_BROWSER_CLI_PATH,
      AGENT_BROWSER_SETTING_KEYS.PLAYWRIGHT_CLI_PATH,
    ],
  },
];
