import {
  type IntegrationsCategorySegment,
  buildIntegrationsPath,
} from "./integrations";
import { SETTINGS_BASE, settingsPathParts } from "./shared";

export type AgentOrgsTabSegment = "agents" | "orgs" | "clis";

export const AGENT_ORGS_NAMESPACE = "agent-orgs";

export interface AgentOrgsPathOptions {
  tab?: AgentOrgsTabSegment | "org" | "integrations";
  category?: IntegrationsCategorySegment;
}

export function buildAgentOrgsPath(options: AgentOrgsPathOptions = {}): string {
  const { tab, category } = options;

  if (category || tab === "integrations") {
    return buildIntegrationsPath({ category });
  }

  const effectiveTab = tab === "org" ? "orgs" : (tab ?? "agents");
  return `${SETTINGS_BASE}/${AGENT_ORGS_NAMESPACE}/${effectiveTab}`;
}

export function parseAgentOrgsPath(pathname: string): {
  tab: AgentOrgsTabSegment;
} {
  const parts = settingsPathParts(pathname);
  const head = parts[0];
  const rawTab = head === AGENT_ORGS_NAMESPACE ? parts[1] : head;

  if (rawTab === "org" || rawTab === "orgs") return { tab: "orgs" };
  if (rawTab === "clis") return { tab: "clis" };
  return { tab: "agents" };
}
