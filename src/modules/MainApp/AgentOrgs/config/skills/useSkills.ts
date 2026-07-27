/**
 * Hook for managing coding agent skills.
 */
import { useCallback } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { useAsyncResource } from "@src/hooks/async";
import type { DescriptionQuality } from "@src/types/extensions/types";

export interface SkillInfo {
  name: string;
  path: string;
  description: string;
  source: string;
  available: boolean;
  always: boolean;
  enabled: boolean;
  requiredBins: string[];
  requiredEnv: string[];
  estimatedTokens: number;
  fullContentTokens: number;
  descriptionQuality: DescriptionQuality;
  version: string;
}

/**
 * @param workspacePath - Workspace path used by the loader to find skills.
 * @param agentId - Agent definition ID that owns the disabled-skill list.
 *   When omitted, the backend falls back to a builtin (`builtin:sde` if
 *   `workspacePath` is set, otherwise `builtin:os`). Pass this from custom
 *   agent UIs so per-agent toggles do not silently rewrite OS/SDE state.
 */
export function useSkills(workspacePath?: string, agentId?: string) {
  const fetchSkills = useCallback(async (serializedScope: string) => {
    const scope = JSON.parse(serializedScope) as {
      agentId?: string;
      workspacePath?: string;
    };
    return rpc.agentOrgs.skills.list(scope);
  }, []);
  const scopeKey = JSON.stringify({ agentId, workspacePath });
  const resource = useAsyncResource<SkillInfo[]>({
    fetcher: fetchSkills,
    initialData: [],
    scopeKey,
  });
  const setSkills = resource.setData;
  const refresh = resource.refresh;

  const readSkill = useCallback(
    async (name: string) => {
      return rpc.agentOrgs.skills.read({ workspacePath, name });
    },
    [workspacePath]
  );

  const toggleSkill = useCallback(
    async (name: string, enabled: boolean) => {
      // Optimistic update: flip the local state immediately so the
      // Switch responds without waiting for the round-trip IPC.
      setSkills((prev) =>
        prev.map((skill) =>
          skill.name === name ? { ...skill, enabled } : skill
        )
      );
      try {
        await rpc.agentOrgs.skills.toggle({
          workspacePath,
          agentId,
          name,
          enabled,
        });
      } catch (err: unknown) {
        // Roll back on failure and re-sync from backend.
        setSkills((prev) =>
          prev.map((skill) =>
            skill.name === name ? { ...skill, enabled: !enabled } : skill
          )
        );
        refresh();
        throw err;
      }
    },
    [workspacePath, agentId, refresh, setSkills]
  );

  return {
    skills: resource.data,
    loading: resource.loading,
    refresh,
    readSkill,
    toggleSkill,
  };
}
