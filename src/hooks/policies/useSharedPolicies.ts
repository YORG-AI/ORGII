/**
 * Unified policies hook — shared between Settings and Agent Teams.
 *
 * Wraps the `policies_*` Tauri commands for CRUD operations on
 * `.orgii/rules/` files + per-rule agent scope in `rules-config.json`.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("SharedPolicies");

export type PolicySource = "global" | "workspace" | "personal";
export type PolicyKind = "rule" | "automation";

export interface PolicyInfo {
  name: string;
  path: string;
  source: PolicySource;
  enabled: boolean;
  estimatedTokens: number;
  kind: PolicyKind;
  /** Agent IDs this policy applies to. Empty = all agents. */
  agents: string[];
  /** Repo paths the policy is restricted to. Absent = no restriction. */
  scopeRepoPaths?: string[];
  /** Repo paths the policy must not apply to. Absent = no exclusions. */
  scopeExcludeRepoPaths?: string[];
  /** Only set when loaded via loadAllRepoPolicies for workspace-scoped rules */
  repoName?: string;
  repoPath?: string;
}

export interface CursorRepo {
  name: string;
  path: string;
}

export interface UseSharedPoliciesOptions {
  workspacePath?: string;
  autoLoad?: boolean;
}

export function useSharedPolicies(options: UseSharedPoliciesOptions = {}) {
  const { workspacePath, autoLoad = true } = options;
  const fetchPolicies = useCallback(async (serializedScope: string) => {
    const scope = JSON.parse(serializedScope) as {
      workspacePath: string | null;
    };
    try {
      return await invoke<PolicyInfo[]>("policies_list", {
        workspacePath: scope.workspacePath,
      });
    } catch (error) {
      log.error("[SharedPolicies] Failed to list policies:", error);
      throw error;
    }
  }, []);
  const policyResource = useAsyncResource<PolicyInfo[]>({
    autoLoad,
    fetcher: fetchPolicies,
    initialData: [],
    scopeKey: JSON.stringify({ workspacePath: workspacePath ?? null }),
  });
  const policies = policyResource.data;
  const loading = policyResource.loading;
  const refresh = policyResource.refresh;
  const setPolicies = policyResource.setData;

  const readRule = useCallback(
    async (
      name: string,
      source: PolicySource,
      overridePath?: string
    ): Promise<string> => {
      return invoke<string>("policies_read", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        source,
      });
    },
    [workspacePath]
  );

  const createRule = useCallback(
    async (
      name: string,
      content: string,
      source: PolicySource,
      agents: string[] = [],
      scopeRepoPaths?: string[],
      scopeExcludeRepoPaths?: string[],
      overridePath?: string
    ) => {
      await invoke("policies_create", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        content,
        source,
        agents,
        scopeRepoPaths: scopeRepoPaths ?? null,
        scopeExcludeRepoPaths: scopeExcludeRepoPaths ?? null,
      });
      refresh();
    },
    [workspacePath, refresh]
  );

  const updateRule = useCallback(
    async (
      name: string,
      content: string,
      source: PolicySource,
      overridePath?: string
    ) => {
      await invoke("policies_update", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        content,
        source,
      });
      refresh();
    },
    [workspacePath, refresh]
  );

  const deleteRule = useCallback(
    async (name: string, source: PolicySource, overridePath?: string) => {
      await invoke("policies_delete", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        source,
      });
      refresh();
    },
    [workspacePath, refresh]
  );

  const toggleRule = useCallback(
    async (
      name: string,
      enabled: boolean,
      source: PolicySource,
      overridePath?: string
    ) => {
      // Optimistic update: flip the local state immediately so the
      // Switch responds without waiting for the round-trip IPC.
      setPolicies((prev) =>
        prev.map((policy) =>
          policy.name === name && policy.source === source
            ? { ...policy, enabled }
            : policy
        )
      );
      try {
        await invoke("policies_toggle", {
          workspacePath: overridePath ?? workspacePath ?? null,
          name,
          enabled,
          source,
        });
      } catch (err: unknown) {
        // Roll back on failure and re-sync from backend.
        setPolicies((prev) =>
          prev.map((policy) =>
            policy.name === name && policy.source === source
              ? { ...policy, enabled: !enabled }
              : policy
          )
        );
        refresh();
        throw err;
      }
    },
    [workspacePath, refresh, setPolicies]
  );

  const setAgents = useCallback(
    async (
      name: string,
      source: PolicySource,
      agents: string[],
      overridePath?: string
    ) => {
      await invoke("policies_set_agents", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        source,
        agents,
      });
      refresh();
    },
    [workspacePath, refresh]
  );

  const setScope = useCallback(
    async (
      name: string,
      source: PolicySource,
      scopeRepoPaths?: string[],
      scopeExcludeRepoPaths?: string[],
      overridePath?: string
    ) => {
      await invoke("policies_set_scope", {
        workspacePath: overridePath ?? workspacePath ?? null,
        name,
        source,
        scopeRepoPaths: scopeRepoPaths ?? null,
        scopeExcludeRepoPaths: scopeExcludeRepoPaths ?? null,
      });
      refresh();
    },
    [workspacePath, refresh]
  );

  /**
   * Stream policies from multiple repos in parallel.
   *
   * Global and Personal rules are deduped (emitted once from whichever
   * repo resolves first) — both live outside any single repo and are
   * returned by every per-repo `policies_list` call, so without dedup
   * they would appear N times in a Multi-repo Workspace.
   *
   * Workspace rules are tagged with repoName / repoPath so the table can
   * show their owning repo.
   */
  const loadAllRepoPolicies = useCallback(
    (
      repos: CursorRepo[],
      onBatch: (rules: PolicyInfo[]) => void,
      onDone: () => void
    ): (() => void) => {
      let cancelled = false;
      let pending = repos.length;
      const emittedGlobals = new Set<string>();
      const emittedPersonals = new Set<string>();

      if (pending === 0) {
        onDone();
        return () => {};
      }

      for (const repo of repos) {
        invoke<PolicyInfo[]>("policies_list", { workspacePath: repo.path })
          .then((raw) => {
            if (cancelled) return;
            const batch: PolicyInfo[] = [];
            for (const rule of raw) {
              if (rule.source === "global") {
                if (!emittedGlobals.has(rule.name)) {
                  emittedGlobals.add(rule.name);
                  batch.push(rule);
                }
              } else if (rule.source === "personal") {
                if (!emittedPersonals.has(rule.name)) {
                  emittedPersonals.add(rule.name);
                  batch.push(rule);
                }
              } else {
                batch.push({
                  ...rule,
                  repoName: repo.name,
                  repoPath: repo.path,
                });
              }
            }
            if (batch.length > 0) onBatch(batch);
          })
          .catch((err: unknown) => {
            if (!cancelled)
              log.error(
                `[SharedPolicies] Failed to list policies for ${repo.name}:`,
                err
              );
          })
          .finally(() => {
            if (cancelled) return;
            pending--;
            if (pending === 0) onDone();
          });
      }

      return () => {
        cancelled = true;
      };
    },
    []
  );

  return {
    policies,
    loading,
    refresh,
    readRule,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
    setAgents,
    setScope,
    loadAllRepoPolicies,
  };
}
