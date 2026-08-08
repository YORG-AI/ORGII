import type { DispatchCategory } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentRegistry } from "@src/store/session/agentRegistryAtom";
import {
  SESSION_TARGET_KIND,
  type SessionTargetKind,
} from "@src/store/session/creatorStateAtom";

export interface SessionCreatorAgentHeroContent {
  name: string;
  description: string;
  danger: boolean;
}

const NO_AGENT_NAME = "Select an agent";
const NO_AGENT_DESCRIPTION = "Choose an agent to see what it can help you with";

const GENERIC_DESCRIPTION =
  "Ready to help with your next task in this workspace";

const CURSOR_IDE_DESCRIPTION =
  "Browse and continue Cursor IDE chat sessions inside ORGII";
const HUMAN_SESSION_DESCRIPTION =
  "Start with one note, then keep appending updates over time";

/** English-only hero copy for built-in agents when the definition has no description. */
const BUILTIN_HERO_DESCRIPTIONS: Record<string, string> = {
  "builtin:os":
    "Your always-on assistant for workspace files, shell, and desktop tasks",
  "builtin:sde":
    "Plans, writes, and ships code in your repo with full tool access",
  "builtin:wingman":
    "Watches your screen and assists in real time while you work",
  "builtin:gateway":
    "Routes messages between channels and agents without running its own LLM",
};

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.$/, "");
}

function resolveBuiltinDescription(agentDefinition?: AgentDefinition): string {
  const fromDefinition = agentDefinition?.description?.trim();
  if (fromDefinition) return stripTrailingPeriod(fromDefinition);

  const agentId = agentDefinition?.id;
  if (agentId && BUILTIN_HERO_DESCRIPTIONS[agentId]) {
    return BUILTIN_HERO_DESCRIPTIONS[agentId];
  }

  return GENERIC_DESCRIPTION;
}

function resolveCliDescription(
  cliAgentType: CliAgentType,
  agentRegistry: AgentRegistry
): string {
  const registryAgent = agentRegistry.agents.find(
    (agent) => agent.name === cliAgentType
  );
  const fromRegistry = registryAgent?.description?.trim();
  if (fromRegistry) return stripTrailingPeriod(fromRegistry);

  return `Runs through ${formatAgentType(cliAgentType)} with local tool access`;
}

function resolveOrgDescription(
  selectedAgentOrgId: string,
  orgs: OrgMember[]
): string {
  const org = orgs.find((member) => member.id === selectedAgentOrgId);
  if (!org) return GENERIC_DESCRIPTION;

  const fromDescription = org.description?.trim();
  if (fromDescription) return stripTrailingPeriod(fromDescription);

  const fromRole = org.role?.trim();
  if (fromRole) return stripTrailingPeriod(fromRole);

  return "Coordinates multiple agents to work on tasks together";
}

export function resolveSessionCreatorAgentHeroContent(options: {
  hasAgentSelected: boolean;
  dispatchCategory: DispatchCategory;
  targetKind: SessionTargetKind;
  selectedAgentDefinition?: AgentDefinition;
  resolvedAgentName: string | null;
  cliAgentType?: CliAgentType | null;
  selectedAgentOrgId?: string | null;
  orgs: OrgMember[];
  agentRegistry: AgentRegistry;
  isOSMode: boolean;
}): SessionCreatorAgentHeroContent {
  const {
    hasAgentSelected,
    dispatchCategory,
    targetKind,
    selectedAgentDefinition,
    resolvedAgentName,
    cliAgentType,
    selectedAgentOrgId,
    orgs,
    agentRegistry,
    isOSMode,
  } = options;

  if (!hasAgentSelected) {
    return {
      name: NO_AGENT_NAME,
      description: NO_AGENT_DESCRIPTION,
      danger: true,
    };
  }

  if (targetKind === SESSION_TARGET_KIND.AGENT_ORG && selectedAgentOrgId) {
    const org = orgs.find((member) => member.id === selectedAgentOrgId);
    return {
      name: org?.name ?? resolvedAgentName ?? "Agent team",
      description: resolveOrgDescription(selectedAgentOrgId, orgs),
      danger: false,
    };
  }

  if (dispatchCategory === "cli_agent" && cliAgentType) {
    const registryAgent = agentRegistry.agents.find(
      (agent) => agent.name === cliAgentType
    );
    return {
      name: registryAgent?.displayName ?? formatAgentType(cliAgentType),
      description: resolveCliDescription(cliAgentType, agentRegistry),
      danger: false,
    };
  }

  if (dispatchCategory === "cursor_ide") {
    return {
      name: resolvedAgentName ?? "Cursor IDE",
      description: CURSOR_IDE_DESCRIPTION,
      danger: false,
    };
  }

  if (dispatchCategory === "human_session") {
    return {
      name: resolvedAgentName ?? "Work log",
      description: HUMAN_SESSION_DESCRIPTION,
      danger: false,
    };
  }

  if (dispatchCategory === "rust_agent") {
    return {
      name: resolvedAgentName ?? (isOSMode ? "OS Agent" : "Agent"),
      description: resolveBuiltinDescription(selectedAgentDefinition),
      danger: false,
    };
  }

  return {
    name: resolvedAgentName ?? "Agent",
    description: GENERIC_DESCRIPTION,
    danger: false,
  };
}
