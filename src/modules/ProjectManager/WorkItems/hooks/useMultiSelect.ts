import { emit } from "@tauri-apps/api/event";
import { useCallback, useState } from "react";

import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

const logger = createLogger("useMultiSelect");

interface UseMultiSelectOptions {
  filteredWorkItems: WorkItemExtended[];
  /** Fallback single-item delete (used when batch delete fails or is not available) */
  onDelete: (workItemId: string) => Promise<void>;
  /** Project slug for batch operations */
  projectSlug?: string | null;
  /** Get short ID for a work item (required for batch delete) */
  getShortId?: (workItemId: string) => string | null;
  /** Callback after batch delete completes (for UI refresh) */
  onBatchDeleteComplete?: () => void;
  /** One confirmation for the whole batch; false leaves selection intact. */
  onBeforeDelete?: (count: number) => Promise<boolean>;
}

export function useMultiSelect({
  filteredWorkItems,
  onDelete,
  projectSlug,
  getShortId,
  onBatchDeleteComplete,
  onBeforeDelete,
}: UseMultiSelectOptions) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const handleCheckedChange = useCallback(
    (workItemId: string, checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (checked) {
          next.add(workItemId);
        } else {
          next.delete(workItemId);
        }
        return next;
      });
    },
    []
  );

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(filteredWorkItems.map((item) => item.session_id)));
  }, [filteredWorkItems]);

  const handleUnselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (onBeforeDelete && !(await onBeforeDelete(ids.length))) return;

    setBulkDeleting(true);

    try {
      if (projectSlug && getShortId) {
        const shortIds: string[] = [];
        for (const workItemId of ids) {
          const shortId = getShortId(workItemId);
          if (shortId) {
            shortIds.push(shortId);
          }
        }

        if (shortIds.length > 0) {
          const result = await projectApi.batchDeleteWorkItems(
            projectSlug,
            shortIds
          );

          if (result.errors.length > 0) {
            logger.warn(
              `Batch delete partial failure: ${result.errors.length} items failed`,
              result.errors
            );
          }

          logger.info(
            `Batch deleted ${result.deleted.length} work items (${result.errors.length} errors)`
          );

          await emit("orgii-data-changed");
          onBatchDeleteComplete?.();
          setSelectedIds(new Set());
          return;
        }
      }

      logger.info("Using fallback sequential delete for batch operation");
      for (const workItemId of ids) {
        await onDelete(workItemId);
      }
      await emit("orgii-data-changed");
      setSelectedIds(new Set());
    } catch (err) {
      logger.error("Batch delete failed:", err);
      for (const workItemId of ids) {
        try {
          await onDelete(workItemId);
        } catch (deleteErr) {
          logger.error(`Failed to delete ${workItemId}:`, deleteErr);
        }
      }
      setSelectedIds(new Set());
    } finally {
      setBulkDeleting(false);
    }
  }, [
    selectedIds,
    onBeforeDelete,
    onDelete,
    projectSlug,
    getShortId,
    onBatchDeleteComplete,
  ]);

  return {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  };
}
