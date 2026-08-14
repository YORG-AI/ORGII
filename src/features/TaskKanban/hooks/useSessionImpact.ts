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

/**
 * Project the orgtrack summary payload down to the sessions the board can
 * actually render. The command answers for every session ever recorded, so
 * retaining its full response in React state grows with the database rather
 * than with the visible roster.
 */
export function impactFromSummaries(
  summaries: readonly CoreSessionSummary[],
  retainedSessionIds: ReadonlySet<string>
): Map<string, SessionImpactStats> {
  const impactBySessionId = new Map<string, SessionImpactStats>();
  for (const summary of summaries) {
    if (!retainedSessionIds.has(summary.sessionId)) continue;
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

/** `\u0000` cannot appear in a session id, so it is a safe id-list separator. */
const SESSION_ID_SEPARATOR = "\u0000";
const EMPTY_IMPACT: ReadonlyMap<string, SessionImpactStats> = new Map();

export function sessionImpactRosterKey(sessions: readonly Session[]): string {
  return sessions
    .map((session) => session.session_id)
    .sort()
    .join(SESSION_ID_SEPARATOR);
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
  const [summaryImpact, setSummaryImpact] =
    useState<ReadonlyMap<string, SessionImpactStats>>(EMPTY_IMPACT);
  // Identity-stable across roster re-renders that do not change membership,
  // and it also carries the id set the response must be projected onto — so
  // the effect needs no extra ref to read the current roster.
  const rosterKey = useMemo(() => sessionImpactRosterKey(sessions), [sessions]);

  useEffect(() => {
    const retainedSessionIds = new Set(
      rosterKey ? rosterKey.split(SESSION_ID_SEPARATOR) : []
    );
    // An empty roster needs no request; the read-time projection below drops
    // whatever the previous roster left behind.
    if (retainedSessionIds.size === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const nextSummaries = await getOrgtrackSessionSummaries();
        if (cancelled) return;
        // Only the projection is retained; the full response is released as
        // soon as this callback returns.
        setSummaryImpact(
          impactFromSummaries(nextSummaries, retainedSessionIds)
        );
      } catch (err) {
        logger.warn("failed to load orgtrack core summaries", { err });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rosterKey]);

  const impactBySessionId = useMemo(() => {
    const nextImpact = new Map<string, SessionImpactStats>();
    for (const session of sessions) {
      // Source-owned stats win over the materialized orgtrack summary.
      const impact =
        impactFromSession(session) ?? summaryImpact.get(session.session_id);
      if (impact) {
        nextImpact.set(session.session_id, impact);
      }
    }
    return nextImpact;
  }, [sessions, summaryImpact]);

  return useMemo(() => ({ impactBySessionId }), [impactBySessionId]);
}
