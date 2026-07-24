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
  const [state, setState] = useState<TeamInboxWorkItemBodyState>({
    body: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ body: null, loading: true });

    const request = projectId
      ? projectApi.readWorkItem(projectId, workItemId)
      : projectApi.readStandaloneWorkItem(workItemId);

    void request
      .then((workItem) => {
        if (cancelled) return;
        const body = workItem.body.trim();
        setState({ body: body.length > 0 ? body : null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn("Failed to load Team Inbox Work Item body", error);
        setState({ body: null, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, workItemId]);

  return state;
}
