/**
 * Hook for installed skills management.
 *
 * Combines:
 * - Local installed list via skills_list
 * - Toggle via skills_toggle
 * - Detail fetch/update for already-installed skills
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";
import { scanInstalledSkills } from "@src/hooks/skills/installedSkillsScan";
import {
  installedSkillsAtom,
  installedSkillsLoadingAtom,
} from "@src/store/skills/installedSkillsAtom";
import type {
  HubInstallResult,
  HubSkillDetail,
  InstalledSkill,
  SkillUpdateInfo,
} from "@src/types/extensions";

const log = createLogger("SkillsHub");

function normalizeWorkspacePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getUniqueWorkspacePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const path of paths) {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    uniquePaths.push(normalizedPath);
  }
  return uniquePaths;
}

interface UseSkillsHubOptions {
  /** When false, skips the initial installed-skills fetch (no Tauri IPC on mount). */
  enabled?: boolean;
  /**
   * Repo/workspace paths to query ALONGSIDE the global scope, on every load
   * and refresh. Repo-scoped skills live in `{repo}/.orgii/skills/` or are
   * parsed in place from `{repo}/.<tool>/skills/` and `{repo}/skills/`; they are
   * only returned when their repo path is queried. Other consumers omit this
   * and stay global-only. Callers should memoize this array to keep the load stable.
   */
  workspacePaths?: string[];
}

export function useSkillsHub({
  enabled = true,
  workspacePaths,
}: UseSkillsHubOptions = {}) {
  const [installedSkills, setInstalledSkills] = useAtom(installedSkillsAtom);
  const [installedLoading, setInstalledLoading] = useAtom(
    installedSkillsLoadingAtom
  );

  const [detailSlug, setDetailSlug] = useState<string | null>(null);

  const [updates, setUpdates] = useState<SkillUpdateInfo[]>([]);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const mountedRef = useMounted();
  const refreshSeqRef = useRef(0);

  // Serialize the configured workspace paths into a stable primitive so the
  // load effect and refresh callbacks don't churn on each render when the
  // caller passes a fresh array reference. Reconstructed where needed.
  const workspacePathsKey = getUniqueWorkspacePaths(workspacePaths ?? []).join(
    "\0"
  );

  const listInstalledSkills = useCallback(
    async (workspacePaths?: string[], options?: { force?: boolean }) => {
      // Bounded/coalesced shared scan. Always queries the global scope plus any
      // workspace/repo paths so repo-scoped skills (`.<tool>/skills` and root
      // `skills`) appear. `force` bypasses the TTL after a mutation.
      return scanInstalledSkills(
        getUniqueWorkspacePaths(workspacePaths ?? []),
        {
          force: options?.force,
        }
      );
    },
    []
  );

  const refreshInstalled = useCallback(
    async (extraWorkspacePaths?: string[], options?: { scoped?: boolean }) => {
      // Default refresh re-queries configured workspace scopes, unioned with
      // any extra paths. Scoped refresh intentionally uses only the supplied
      // paths, so a selected source tab can revalidate just that scope.
      const configuredPaths = workspacePathsKey
        ? workspacePathsKey.split("\0")
        : [];
      const scopePaths = options?.scoped
        ? getUniqueWorkspacePaths(extraWorkspacePaths ?? [])
        : getUniqueWorkspacePaths([
            ...configuredPaths,
            ...(extraWorkspacePaths ?? []),
          ]);
      const refreshSeq = ++refreshSeqRef.current;
      setInstalledLoading(true);
      try {
        const result = await listInstalledSkills(scopePaths, { force: true });
        if (refreshSeq === refreshSeqRef.current) {
          setInstalledSkills(result);
        }
      } catch (err) {
        log.error("[SkillsHub] Failed to list installed skills:", err);
      } finally {
        if (refreshSeq === refreshSeqRef.current) {
          setInstalledLoading(false);
        }
      }
    },
    [
      listInstalledSkills,
      workspacePathsKey,
      setInstalledSkills,
      setInstalledLoading,
    ]
  );

  const refreshInstalledAfterDelete = useCallback(
    async (deletedName: string) => {
      // Query the same scopes the list is displaying so the re-fetch doesn't
      // drop repo-scoped skills while polling for the deleted one to vanish.
      const scopePaths = workspacePathsKey ? workspacePathsKey.split("\0") : [];
      const retryDelaysMs = [100, 300, 700];
      for (const delayMs of retryDelaysMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const result = await listInstalledSkills(scopePaths, { force: true });
        if (!result.some((skill) => skill.name === deletedName)) {
          setInstalledSkills(result);
          return;
        }
      }
      setInstalledSkills((current) =>
        current.filter((skill) => skill.name !== deletedName)
      );
    },
    [listInstalledSkills, workspacePathsKey, setInstalledSkills]
  );

  useEffect(() => {
    if (!enabled) {
      setInstalledLoading(false);
      return;
    }
    let cancelled = false;
    const scopePaths = workspacePathsKey ? workspacePathsKey.split("\0") : [];

    const load = async () => {
      const refreshSeq = ++refreshSeqRef.current;
      setInstalledLoading(true);
      try {
        const result = await listInstalledSkills(scopePaths);
        if (!cancelled && refreshSeq === refreshSeqRef.current) {
          setInstalledSkills(result);
        }
      } catch (err) {
        if (!cancelled)
          log.error("[SkillsHub] Failed to list installed skills:", err);
      } finally {
        if (!cancelled && refreshSeq === refreshSeqRef.current) {
          setInstalledLoading(false);
        }
      }
    };
    load();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    listInstalledSkills,
    workspacePathsKey,
    setInstalledLoading,
    setInstalledSkills,
  ]);

  const loadSkillDetail = useCallback(
    async (
      slug: string,
      context: AsyncResourceFetchContext<HubSkillDetail | null>
    ) => {
      let cached: HubSkillDetail | null = null;
      try {
        cached = await invoke<HubSkillDetail | null>(
          "skills_hub_detail_cache_read",
          { name: slug }
        );
        if (cached) context.publish(cached);
      } catch {
        // Cache miss is fine, continue to network.
      }

      try {
        const detail = await invoke<HubSkillDetail>("skills_hub_detail", {
          slug,
        });
        void invoke("skills_hub_detail_cache_write", {
          name: slug,
          detail,
        }).catch(() => {
          // Cache write failure is non-critical.
        });
        return detail;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    },
    []
  );
  const detailResource = useAsyncResource<HubSkillDetail | null>({
    enabled: Boolean(detailSlug),
    fetcher: loadSkillDetail,
    initialData: null,
    scopeKey: detailSlug,
  });
  const refreshDetail = detailResource.refresh;

  const fetchDetail = useCallback(
    (slug: string) => {
      if (slug === detailSlug) {
        void refreshDetail();
        return;
      }
      setDetailSlug(slug);
    },
    [detailSlug, refreshDetail]
  );

  const clearDetail = useCallback(() => {
    setDetailSlug(null);
  }, []);

  const uninstall = useCallback(
    async (name: string) => {
      let previousSkills: InstalledSkill[] | null = null;
      setInstalledSkills((current) => {
        previousSkills = current;
        return current.filter((skill) => skill.name !== name);
      });

      try {
        await invoke("skills_hub_uninstall", { name });
        await refreshInstalledAfterDelete(name);
      } catch (error) {
        if (previousSkills) {
          setInstalledSkills(previousSkills);
        }
        throw error;
      }
    },
    [refreshInstalledAfterDelete, setInstalledSkills]
  );

  const readSkill = useCallback(async (name: string): Promise<string> => {
    return invoke<string>("skills_read", { workspacePath: null, name });
  }, []);

  const toggleSkill = useCallback(
    async (name: string, enabled: boolean) => {
      await invoke("skills_toggle", { workspacePath: null, name, enabled });
      await refreshInstalled();
    },
    [refreshInstalled]
  );

  const checkUpdates = useCallback(async () => {
    setUpdatesLoading(true);
    try {
      const result = await invoke<SkillUpdateInfo[]>("skills_check_updates");
      if (mountedRef.current) setUpdates(result);
    } catch (err) {
      if (mountedRef.current)
        log.error("[SkillsHub] Failed to check updates:", err);
    } finally {
      if (mountedRef.current) setUpdatesLoading(false);
    }
  }, [mountedRef]);

  const updateSkill = useCallback(
    async (slug: string): Promise<boolean> => {
      setUpdating(slug);
      try {
        await invoke<HubInstallResult>("skills_hub_update", { slug });
        if (mountedRef.current) {
          setUpdates((prev) => prev.filter((upd) => upd.slug !== slug));
          await refreshInstalled();
        }
        return true;
      } catch (err) {
        if (mountedRef.current)
          log.error("[SkillsHub] Failed to update skill:", err);
        return false;
      } finally {
        if (mountedRef.current) setUpdating(null);
      }
    },
    [refreshInstalled, mountedRef]
  );

  return {
    installedSkills,
    installedLoading,
    refreshInstalled,
    toggleSkill,
    uninstall,
    readSkill,
    skillDetail: detailResource.data,
    detailLoading: detailResource.loading,
    detailError: detailResource.error,
    fetchDetail,
    clearDetail,
    updates,
    updatesLoading,
    checkUpdates,
    updateSkill,
    updating,
  };
}
