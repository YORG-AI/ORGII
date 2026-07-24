import { useEffect, useState } from "react";

import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";

import type { WorkItemTarget } from "./domain";

const log = createLogger("TeamInboxWorkItemBody");

export interface TeamInboxWorkItemBodyState {
  /** Full Markdown body once resolved, or null while loading / empty / failed. */
  body: string | null;
  loading: boolean;
}

/**
 * Lazily loads the full Work Item body for the selected assigned inbox item so
 * the detail preview can render the real content instead of the short list
 * excerpt. The fetch reuses the same project store adapters as navigation and is
 * demand-driven (one read per selection, no polling); stale responses are
 * discarded when the selection changes.
 */
export function useTeamInboxWorkItemBody(
  target: WorkItemTarget
): TeamInboxWorkItemBodyState {
  const { projectId, workItemId } = target;
  const requestKey = `${projectId}:${workItemId}`;
  /**
   * Holds the resolved body together with the key it was fetched for. Loading
   * is derived by comparing that key against the current target rather than
   * reset by a synchronous setState in the effect, which would cascade an
   * extra render on every selection change.
   */
  const [resolved, setResolved] = useState<{
    key: string;
    body: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const request = projectId
      ? projectApi.readWorkItem(projectId, workItemId)
      : projectApi.readStandaloneWorkItem(workItemId);

    void request
      .then((workItem) => {
        if (cancelled) return;
        const body = workItem.body.trim();
        setResolved({ key: requestKey, body: body.length > 0 ? body : null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn("Failed to load Team Inbox Work Item body", error);
        setResolved({ key: requestKey, body: null });
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, workItemId, requestKey]);

  return resolved?.key === requestKey
    ? { body: resolved.body, loading: false }
    : { body: null, loading: true };
}
