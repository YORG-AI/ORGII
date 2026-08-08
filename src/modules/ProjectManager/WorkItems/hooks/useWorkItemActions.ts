/**
 * useWorkItemActions
 *
 * Actions for creating, updating, and deleting work items.
 */
import { useCallback, useState } from "react";

import { projectApi } from "@src/api/http/project";
import { allocateCloudAwareWorkItemId } from "@src/features/Org2Cloud/cloudShortId";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("useWorkItemActions");

interface UseWorkItemActionsOptions {
  onSuccess?: () => void;
  onError?: (error: string) => void;
  teamId?: string | null;
  /** Project slug — work items are scoped per project */
  projectSlug?: string | null;
}

export function useWorkItemActions(options: UseWorkItemActionsOptions = {}) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectSlug = options.projectSlug ?? null;

  const deleteWorkItem = useCallback(
    async (id: string, shortId?: string) => {
      setUpdating(id);
      setError(null);

      try {
        if (projectSlug && shortId) {
          await projectApi.deleteWorkItem(projectSlug, shortId);
        } else {
          throw new Error(
            "Cannot delete work item: missing projectSlug or shortId"
          );
        }
        options.onSuccess?.();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to delete work item";
        setError(errorMessage);
        options.onError?.(errorMessage);
        log.error("[useWorkItemActions] Delete error:", err);
      } finally {
        setUpdating(null);
      }
    },
    [options, projectSlug]
  );

  const restoreWorkItem = useCallback(
    async (id: string, shortId?: string) => {
      setUpdating(id);
      setError(null);

      try {
        if (projectSlug && shortId) {
          await projectApi.restoreWorkItem(projectSlug, shortId);
        } else {
          throw new Error(
            "Cannot restore work item: missing projectSlug or shortId"
          );
        }
        options.onSuccess?.();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to restore work item";
        setError(errorMessage);
        options.onError?.(errorMessage);
        log.error("[useWorkItemActions] Restore error:", err);
      } finally {
        setUpdating(null);
      }
    },
    [options, projectSlug]
  );

  const createWorkItem = useCallback(
    async (data: {
      name: string;
      description?: string;
      status?: string;
      priority?: string;
      project_id?: string;
      assignee_id?: string;
      milestone_id?: string;
      start_date?: string;
      target_date?: string;
    }): Promise<string | null> => {
      if (updating) return null;
      setUpdating("new");
      setError(null);

      try {
        if (!projectSlug) {
          log.error("[useWorkItemActions] No projectSlug");
          options.onError?.("No project available");
          return null;
        }

        // Collab-synced orgs allocate on the server (design §16.5) so two
        // members can never mint the same PREFIX-n; local orgs fall through
        // to the local counter inside the helper.
        const shortId = await allocateCloudAwareWorkItemId(projectSlug);

        // Canonical work.create: the Rust service owns row construction.
        await projectApi.createWorkItem(projectSlug, shortId, {
          title: data.name,
          body: data.description ?? "",
          projectId: data.project_id,
          status: data.status,
          priority: data.priority,
          assignee: data.assignee_id,
          milestone: data.milestone_id,
          startDate: data.start_date,
          targetDate: data.target_date,
        });

        options.onSuccess?.();
        return shortId;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to create work item";
        setError(errorMessage);
        options.onError?.(errorMessage);
        log.error("[useWorkItemActions] Create error:", err);
        return null;
      } finally {
        setUpdating(null);
      }
    },
    [updating, options, projectSlug]
  );

  return {
    createWorkItem,
    deleteWorkItem,
    restoreWorkItem,
    updating,
    error,
  };
}

export default useWorkItemActions;
