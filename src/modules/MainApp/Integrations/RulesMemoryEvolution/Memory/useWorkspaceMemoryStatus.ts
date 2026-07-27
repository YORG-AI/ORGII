/**
 * useWorkspaceMemoryStatus Hook
 *
 * Fetches L2 workspace memory status (file count, consolidation state)
 * from the Rust backend. Returns null while loading or if no workspace
 * is available.
 *
 * Scope semantics:
 *   - `"workspace"`: the user's currently-active workspace folder
 *     (`activeFolderAtom`). Always points at a real workspace once one
 *     is selected; there is no fallback to the personal workspace.
 *   - `"personal"`: the OS Agent's personal workspace
 *     (`~/.orgii/personal/workspace/`) regardless of the active folder.
 */
import { useAtomValue } from "jotai";
import { useCallback } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type { WorkspaceMemoryStatus } from "@src/api/tauri/rpc/schemas/workspaceMemory";
import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { activeFolderAtom } from "@src/store/workspace/derived";

const log = createLogger("useWorkspaceMemoryStatus");

export type WorkspaceMemoryScope = "workspace" | "personal";

interface ResolvedWorkspace {
  path: string | null;
}

function useWorkspacePath(scope: WorkspaceMemoryScope): ResolvedWorkspace {
  const activeFolder = useAtomValue(activeFolderAtom);
  const fetchPersonalWorkspace = useCallback(async () => {
    try {
      return await rpc.agentOrgs.memory.personalWorkspace();
    } catch (error) {
      log.warn(
        "[useWorkspaceMemoryStatus] project_personal_workspace failed:",
        error
      );
      throw error;
    }
  }, []);
  const personalWorkspace = useAsyncResource<string | null>({
    enabled: scope === "personal",
    fetcher: fetchPersonalWorkspace,
    initialData: null,
    scopeKey: scope === "personal" ? "personal-workspace" : null,
  });

  if (scope === "personal") return { path: personalWorkspace.data };
  return { path: activeFolder?.path ?? null };
}

export function useWorkspaceMemoryStatus(
  scope: WorkspaceMemoryScope = "workspace"
) {
  const { path: workspace } = useWorkspacePath(scope);
  const fetchStatus = useCallback(async (workspacePath: string) => {
    try {
      return await rpc.workspaceMemory.status({ workspace: workspacePath });
    } catch (error) {
      log.warn("[WorkspaceMemoryStatus] fetch failed:", error);
      throw error;
    }
  }, []);
  const statusResource = useAsyncResource<WorkspaceMemoryStatus | null>({
    enabled: Boolean(workspace),
    fetcher: fetchStatus,
    initialData: null,
    scopeKey: workspace,
  });

  return {
    status: statusResource.data,
    loading: statusResource.loading,
    workspace,
    refresh: statusResource.refresh,
  };
}
