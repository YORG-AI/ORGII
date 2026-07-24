import { useCallback, useEffect, useState } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import type { WorkItem } from "@src/types/core/workItem";

import type { WorkItemTarget } from "./domain";

const log = createLogger("TeamInboxWorkItem");

export interface TeamInboxWorkItemState {
  /** Full work item once resolved, or null while loading / failed. */
  workItem: WorkItem | null;
  loading: boolean;
  /** Persists a property edit and swaps in the returned item. */
  updateWorkItem: (updates: Partial<WorkItem>) => void;
}

/**
 * Loads the full Work Item behind an assigned inbox row so the detail pane can
 * render the same `WorkItemContent` / `WorkItemProperties` pair the work-item
 * pane uses, instead of a reduced summary of the list payload.
 *
 * The read is demand-driven (one per selection, no polling) and stale responses
 * are discarded when the selection changes.
 */
export function useTeamInboxWorkItem(
  target: WorkItemTarget
): TeamInboxWorkItemState {
  const { projectId, workItemId } = target;
  const requestKey = `${projectId}:${workItemId}`;
  /**
   * Holds the resolved item together with the key it was fetched for. Loading
   * is derived by comparing that key against the current target rather than
   * reset by a synchronous setState in the effect.
   */
  const [resolved, setResolved] = useState<{
    key: string;
    workItem: WorkItem | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const request = projectId
      ? projectApi.readWorkItem(projectId, workItemId)
      : projectApi.readStandaloneWorkItem(workItemId);

    void request
      .then((data) => {
        if (cancelled) return;
        setResolved({
          key: requestKey,
          workItem: enrichedWorkItemToUI(
            standaloneWorkItemDataToEnriched(data)
          ),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn("Failed to load Team Inbox Work Item", error);
        setResolved({ key: requestKey, workItem: null });
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, workItemId, requestKey]);

  const updateWorkItem = useCallback(
    (updates: Partial<WorkItem>) => {
      // Standalone items are written back through a full frontmatter
      // round-trip that only the owning pane assembles, so the inbox edits
      // project-scoped items and leaves standalone ones read-only.
      if (!projectId) return;

      const payload = toWorkItemPartialUpdate(updates);
      if (Object.keys(payload).length === 0) return;

      void projectApi
        .updateWorkItemPartial(projectId, workItemId, payload)
        .then((updated) => {
          setResolved({
            key: requestKey,
            workItem: enrichedWorkItemToUI(updated),
          });
        })
        .catch((error: unknown) => {
          log.warn("Failed to update Team Inbox Work Item", error);
        });
    },
    [projectId, workItemId, requestKey]
  );

  const isResolved = resolved?.key === requestKey;

  return {
    workItem: isResolved ? resolved.workItem : null,
    loading: !isResolved,
    updateWorkItem,
  };
}
