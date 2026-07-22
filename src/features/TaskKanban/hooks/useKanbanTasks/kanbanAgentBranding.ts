const ORGII_RUST_AGENT_DEFINITION_PREFIX = "builtin:";

/** ORGII-shipped Rust definitions share the ORG2 product mark in Kanban. */
export function resolveKanbanAgentIconId(
  agentDefinitionId: string | undefined,
  fallbackIconId: string | undefined
): string | undefined {
  return agentDefinitionId?.startsWith(ORGII_RUST_AGENT_DEFINITION_PREFIX)
    ? "orgii"
    : fallbackIconId;
}
