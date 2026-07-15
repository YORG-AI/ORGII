/**
 * Team chart configuration — tree depth limit, agent color map, agent options builder.
 */
import type { SelectOption } from "@src/components/Select";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import {
  BUILTIN_OS_DEF_ID,
  BUILTIN_SDE_DEF_ID,
} from "@src/util/session/sessionDispatch";

export const MAX_TREE_DEPTH = 4;

/** Color map for built-in agent IDs; custom agents use default color */
export const AGENT_COLORS: Record<string, string> = {
  "user-me": "text-primary-6",
  [BUILTIN_OS_DEF_ID]: "text-[#d97706]",
  [BUILTIN_SDE_DEF_ID]: "text-[#10b981]",
};

export const DEFAULT_AGENT_COLOR = "text-primary-6";

/** Build Select options from Rust-native built-in and custom agents. */
export function buildAgentOptions(
  customAgents: AgentDefinition[],
  builtInAgents: AgentDefinition[] = []
): SelectOption[] {
  const definitionOptions: SelectOption[] = [
    ...builtInAgents,
    ...customAgents,
  ].map((agent) => ({
    label: agent.name,
    value: agent.id,
    dataTestId: `agent-option-${agent.id}`,
  }));

  return definitionOptions;
}
