/**
 * Hook for managing agent policies in Settings.
 * Thin wrapper over the shared useSharedPolicies hook.
 */
import { useSharedPolicies } from "@src/hooks/policies";

export type { PolicySource, PolicyInfo } from "@src/hooks/policies";

export function useAgentPolicies(workspacePath?: string) {
  return useSharedPolicies({ workspacePath });
}
