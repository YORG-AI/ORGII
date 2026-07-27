import type { AvailableAgent } from "@src/config/cliAgents";

import {
  CLI_CLIENT_INLINE_TAB,
  type CliClientInlineTab,
} from "./cliClientInlineTypes";

interface CliClientTabAvailability {
  key: CliClientInlineTab;
  disabled?: boolean;
}

export function hasCliClientActions(
  agent: Pick<
    AvailableAgent,
    "installed" | "installMethods" | "uninstallMethods"
  >
): boolean {
  return agent.installed
    ? agent.uninstallMethods.length > 0
    : agent.installMethods.length > 0;
}

export function resolveCliClientInlineTab(
  activeTab: CliClientInlineTab,
  tabs: readonly CliClientTabAvailability[]
): CliClientInlineTab {
  const match = tabs.find((tab) => tab.key === activeTab && !tab.disabled);
  return match?.key ?? CLI_CLIENT_INLINE_TAB.STATUS;
}
