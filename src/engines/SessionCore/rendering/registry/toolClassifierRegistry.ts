/** Serializable subset of the Rust tool registry used by chat projection. */
export interface ToolClassifierRegistrySnapshot {
  uiCanonicalByName: Record<string, string>;
  simulatorAppByName: Record<string, string>;
}

export const EMPTY_TOOL_CLASSIFIER_REGISTRY: ToolClassifierRegistrySnapshot = {
  uiCanonicalByName: {},
  simulatorAppByName: {},
};

let registry: ToolClassifierRegistrySnapshot = EMPTY_TOOL_CLASSIFIER_REGISTRY;

function addCaseInsensitiveEntries(
  entries: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    normalized[name] = value;
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

export function configureToolClassifierRegistry(
  snapshot: ToolClassifierRegistrySnapshot
): void {
  registry = {
    uiCanonicalByName: addCaseInsensitiveEntries(snapshot.uiCanonicalByName),
    simulatorAppByName: addCaseInsensitiveEntries(snapshot.simulatorAppByName),
  };
}

export function getToolClassifierRegistrySnapshot(): ToolClassifierRegistrySnapshot {
  return {
    uiCanonicalByName: { ...registry.uiCanonicalByName },
    simulatorAppByName: { ...registry.simulatorAppByName },
  };
}

function stripMcpPrefix(name: string): string {
  return name.startsWith("mcp_orgii_") ? name.slice("mcp_orgii_".length) : name;
}

export function resolveToolUiCanonical(rawName: string): string {
  const stripped = stripMcpPrefix(rawName.trim());
  return (
    registry.uiCanonicalByName[stripped] ??
    registry.uiCanonicalByName[stripped.toLowerCase()] ??
    stripped.toLowerCase()
  );
}

export function resolveToolSimulatorApp(
  rawName: string,
  canonicalName?: string
): string | null {
  const stripped = stripMcpPrefix(rawName.trim());
  const canonical = canonicalName
    ? resolveToolUiCanonical(canonicalName)
    : resolveToolUiCanonical(stripped);
  return (
    registry.simulatorAppByName[stripped] ??
    registry.simulatorAppByName[stripped.toLowerCase()] ??
    registry.simulatorAppByName[canonical] ??
    null
  );
}
