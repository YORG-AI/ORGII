import type { AgentOrgsTabSegment } from "@src/config/mainAppPaths";

import type { AvailableCliAgent } from "./types";

export const AGENT_ORGS_TABLE_TABS = ["agents", "orgs", "clis"] as const;

export function resolveAgentOrgsTableTab(
  tab: AgentOrgsTabSegment
): AgentOrgsTabSegment {
  return AGENT_ORGS_TABLE_TABS.includes(
    tab as (typeof AGENT_ORGS_TABLE_TABS)[number]
  )
    ? tab
    : "agents";
}

export function selectInstalledCliAgents(
  agents: readonly AvailableCliAgent[]
): AvailableCliAgent[] {
  return agents
    .filter((agent) => agent.installed)
    .sort((agentA, agentB) =>
      agentA.displayName.localeCompare(agentB.displayName)
    );
}

export function resolveLegacyAgentOrgsRedirect(pathname: string): boolean {
  return pathname.includes("/settings/org");
}
