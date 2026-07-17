import { useEffect, useMemo, useState } from "react";

import { getOrgtrackSessionSummaries } from "@src/api/tauri/lineage";
import type { CoreSessionSummary } from "@src/api/tauri/lineage";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { SessionImpactStats } from "@src/features/KanbanBoard/types";
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session";
import {
  isClaudeCodeHistorySession,
  isCodexAppSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

const logger = createLogger("SessionImpact");

function hasSourceImpactFastPath(session: Session): boolean {
  return (
    session.category === DISPATCH_CATEGORY.RUST_AGENT ||
    isCursorIdeSession(session.session_id) ||
    isCodexAppSession(session.session_id) ||
    isClaudeCodeHistorySession(session.session_id)
  );
}

function impactFromSession(session: Session): SessionImpactStats | undefined {
  if (!hasSourceImpactFastPath(session)) return undefined;

  const touchedFileCount = session.touchedFiles?.length ?? 0;
  const filesChanged =
    session.filesChanged && session.filesChanged > 0
      ? session.filesChanged
      : touchedFileCount;
  const linesAdded = session.linesAdded ?? 0;
  const linesRemoved = session.linesRemoved ?? 0;
  if (filesChanged === 0 && linesAdded === 0 && linesRemoved === 0) {
    return undefined;
  }

  return {
    filesChanged,
    linesAdded,
    linesRemoved,
    relatedCommits: 0,
    committedFiles: 0,
    committedRatePercent: 0,
    touchedFiles: session.touchedFiles,
  };
}

function impactFromSummaries(
  summaries: readonly CoreSessionSummary[]
): Map<string, SessionImpactStats> {
  const impactBySessionId = new Map<string, SessionImpactStats>();
  for (const summary of summaries) {
    impactBySessionId.set(summary.sessionId, {
      filesChanged: summary.filesChanged,
      linesAdded: summary.linesAdded,
      linesRemoved: summary.linesRemoved,
      relatedCommits: summary.relatedCommits,
      committedFiles: Math.round(
        (summary.filesChanged * summary.committedRatePercent) / 100
      ),
      committedRatePercent: summary.committedRatePercent,
    });
  }
  return impactBySessionId;
}

export interface SessionImpactState {
  impactBySessionId: Map<string, SessionImpactStats>;
}

/**
 * Loads already-parsed session impact stats for the Kanban board. This is a
 * read-only view: it surfaces source-owned metadata (`impactFromSession`) and
 * materialized orgtrack summaries (`getOrgtrackSessionSummaries`). Native
 * summaries may lazily refresh their versioned turn index on first access;
 * filtering itself never parses transcripts or invokes provider loaders.
 */
export function useSessionImpact(
  sessions: readonly Session[]
): SessionImpactState {
  const [summaries, setSummaries] = useState<CoreSessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (sessions.length === 0) {
        if (!cancelled) {
          setSummaries([]);
        }
        return;
      }

      try {
        const nextSummaries = await getOrgtrackSessionSummaries();
        if (!cancelled) {
          setSummaries(nextSummaries);
        }
      } catch (err) {
        logger.warn("failed to load orgtrack core summaries", { err });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessions.length]);

  const impactBySessionId = useMemo(() => {
    const nextImpact = impactFromSummaries(summaries);
    for (const session of sessions) {
      const sourceImpact = impactFromSession(session);
      if (sourceImpact) {
        nextImpact.set(session.session_id, sourceImpact);
      }
    }
    return nextImpact;
  }, [sessions, summaries]);

  return useMemo(() => ({ impactBySessionId }), [impactBySessionId]);
}
