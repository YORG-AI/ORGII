import { useCallback, useEffect, useState } from "react";

import { enrichedWorkItemToUI, projectApi } from "@src/api/http/project";
import { allocateCloudAwareWorkItemId } from "@src/features/Org2Cloud/cloudShortId";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import type { WorkItem } from "@src/types/core/workItem";

import { applyWorkItemUpdate } from "../workItemSource";

const logger = createLogger("ProjectPanelView");

/**
 * Project-scoped list source used by the chat pane. It deliberately retains its
 * existing eager load/refresh policy; the full-page data hook separately owns
 * active-view filtering, generation guards, and deleted-item purging.
 */
export function useProjectWorkItemsSource(projectSlug: string | undefined) {
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workItemShortIds, setWorkItemShortIds] = useState<Map<string, string>>(
    new Map()
  );
  const [workItemsLoading, setWorkItemsLoading] = useState(false);
  const [workItemsError, setWorkItemsError] = useState<string | null>(null);
  const loadProjectWorkItems = useCallback(async () => {
    if (!projectSlug) {
      setWorkItems([]);
      setWorkItemShortIds(new Map());
      return;
    }

    setWorkItemsLoading(true);
    setWorkItemsError(null);
    try {
      const viewData = await projectApi.readWorkItemsViewData(projectSlug, {
        view: "list",
      });
      setWorkItemShortIds(
        new Map(viewData.items.map((item) => [item.id, item.shortId]))
      );
      setWorkItems(viewData.items.map(enrichedWorkItemToUI));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load work items";
      logger.error("Failed to load project work items:", error);
      setWorkItemsError(message);
    } finally {
      setWorkItemsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadProjectWorkItems();
  }, [loadProjectWorkItems]);

  useProjectDataChanged(
    useCallback(
      (change) => {
        if (!change?.projectSlug || change.projectSlug === projectSlug) {
          void loadProjectWorkItems();
        }
      },
      [loadProjectWorkItems, projectSlug]
    )
  );

  const getWorkItemShortId = useCallback(
    (workItemId: string) => workItemShortIds.get(workItemId) ?? null,
    [workItemShortIds]
  );

  const handleDeleteWorkItem = useCallback(
    async (workItemId: string) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;
      await projectApi.deleteWorkItem(projectSlug, shortId);
      await loadProjectWorkItems();
    },
    [getWorkItemShortId, loadProjectWorkItems, projectSlug]
  );

  const updateWorkItem = useCallback(
    async (
      workItemId: string,
      updates: Partial<WorkItem>,
      actor?: Parameters<typeof applyWorkItemUpdate>[3]
    ) => {
      if (!projectSlug) return;
      const shortId = getWorkItemShortId(workItemId);
      if (!shortId) return;

      const updated = await applyWorkItemUpdate(
        projectSlug,
        shortId,
        updates,
        actor
      );
      if (!updated) return;
      const updatedItem = enrichedWorkItemToUI(updated);
      setWorkItems((currentItems) =>
        currentItems.map((item) =>
          item.session_id === workItemId ? updatedItem : item
        )
      );
    },
    [getWorkItemShortId, projectSlug, setWorkItems]
  );

  const createWorkItem = useCallback(
    async (input: Parameters<typeof projectApi.createWorkItem>[2]) => {
      if (!projectSlug) return;
      // Collab-synced orgs allocate on the server before the canonical create.
      const shortId = await allocateCloudAwareWorkItemId(projectSlug);
      await projectApi.createWorkItem(projectSlug, shortId, input);
      await loadProjectWorkItems();
    },
    [loadProjectWorkItems, projectSlug]
  );

  return {
    workItems,
    workItemShortIds,
    workItemsLoading,
    workItemsError,
    loadProjectWorkItems,
    getWorkItemShortId,
    handleDeleteWorkItem,
    updateWorkItem,
    createWorkItem,
  };
}
