/**
 * useChatViewOrgtrackSummary
 *
 * Fetches the orgtrack-core session summary (commit/file-change rollups)
 * for a session, re-fetching whenever the session id changes and ignoring
 * stale responses from a superseded fetch.
 */
import { useEffect, useState } from "react";

import {
  type CoreSessionSummary,
  getOrgtrackSessionSummary,
} from "@src/api/tauri/lineage";
import { createLogger } from "@src/hooks/logger";

const logger = createLogger("ChatView");

export function useChatViewOrgtrackSummary(sessionId: string) {
  const [orgtrackSummary, setOrgtrackSummary] =
    useState<CoreSessionSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getOrgtrackSessionSummary(sessionId)
      .then((summary) => {
        if (!cancelled) setOrgtrackSummary(summary);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.warn("failed to load orgtrack session summary", error);
          setOrgtrackSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return orgtrackSummary;
}
