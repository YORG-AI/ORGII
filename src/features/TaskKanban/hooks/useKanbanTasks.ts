/**
 * useKanbanTasks Hook
 *
 * Maps all sessions (both OS Agent and coding) from the global session store
 * into KanbanTask objects for display on the Kanban board.
 *
 * Routing is "needs-the-user" centric — see `mapSessionToKanbanColumn`.
 * "Unread" is intentionally NOT a routing dimension: it is a soft signal
 * carried on `task.isUnread`, used here to sort unread cards to the top
 * of the Done column.
 *
 * Supports time-based filtering: 12h/24h/3d/7d filters out sessions older
 * than the selected window.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";

import { sessionsAtom, visitedSessionsAtom } from "@src/store/session";
import {
  kanbanReplayBoundsAtom,
  kanbanReplayCursorAtom,
  kanbanReplayEventsAtom,
  kanbanReplayModeAtom,
} from "@src/store/ui/kanbanReplayAtom";
import { kanbanManualArchivedSessionsAtom } from "@src/store/ui/kanbanViewStateAtom";
import { dedupeByCanonicalSession } from "@src/util/session/canonicalSessionKey";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import type {
  AgentKanbanColumnId,
  KanbanAutoArchiveTtl,
  KanbanTimeFilter,
} from "../config";
import { KANBAN_COLUMNS, getTimeFilterCutoff } from "../config";
import type { KanbanTask } from "../types";
import { createReplayEvents } from "./useKanbanTasks/replayEvents";
import { applyReplayCursor } from "./useKanbanTasks/replayProjection";
import { sessionToKanbanTask } from "./useKanbanTasks/sessionToKanbanTask";
import { getTaskTimestamp } from "./useKanbanTasks/taskTimestamps";
import { useSessionImpact } from "./useSessionImpact";

// ============================================
// Types
// ============================================

export interface UseKanbanTasksOptions {
  timeFilter?: KanbanTimeFilter;
  autoArchiveTtl?: KanbanAutoArchiveTtl;
  /**
   * When provided, only sessions whose `session_id` is in this set are
   * included on the board.
   *
   * Used by team-scoped Kanban embeds (e.g. the `Kanban` sub-tab in the
   * Inbox per-team panel) to restrict the board to sessions linked to a
   * specific Agent Team run without forking the hook.
   */
  sessionIdFilter?: ReadonlySet<string>;
}

export interface UseKanbanTasksReturn {
  tasks: KanbanTask[];
  allTasks: KanbanTask[];
  groupedTasks: Map<AgentKanbanColumnId, KanbanTask[]>;
}

// ============================================
// Hook
// ============================================

/**
 * Reads all sessions from the global store and converts them to KanbanTasks.
 * Applies time-based filtering when a timeFilter is provided.
 */
export function useKanbanTasks(
  options: UseKanbanTasksOptions = {}
): UseKanbanTasksReturn {
  const {
    timeFilter = "12h",
    autoArchiveTtl = "24h",
    sessionIdFilter,
  } = options;
  const sessions = useAtomValue(sessionsAtom);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const manualArchivedSessionIds = useAtomValue(
    kanbanManualArchivedSessionsAtom
  );
  const replayMode = useAtomValue(kanbanReplayModeAtom);
  const replayCursor = useAtomValue(kanbanReplayCursorAtom);
  const setReplayBounds = useSetAtom(kanbanReplayBoundsAtom);
  const setReplayEvents = useSetAtom(kanbanReplayEventsAtom);

  // "Now" tick — owned by an interval rather than read inline so the
  // memo stays pure (React's hooks-purity rule rejects `Date.now()` in
  // a useMemo body). 30s granularity is plenty for a board view; the
  // right edge also advances whenever a session actually moves, which
  // is the path that matters in practice.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const visibleSessions = useMemo(
    () =>
      // Collapse dual-ingested duplicates (e.g. a Codex rollout surfaced both
      // as a native CLI session and as imported "Codex App" history) to one
      // card, keeping the copy that carries impact / tokens / model. Runs
      // before task construction so both the board and List view are deduped.
      dedupeByCanonicalSession(
        sessions.filter(
          (session) =>
            isPrimarySessionListSession(session) &&
            (!sessionIdFilter || sessionIdFilter.has(session.session_id))
        )
      ),
    [sessions, sessionIdFilter]
  );
  const { impactBySessionId } = useSessionImpact(visibleSessions);

  // Pair sessions with their kanban-task projection once. Downstream
  // code reads from this so we don't re-iterate `sessions` per concern.
  // The filter is applied here so every later memo (events, bounds,
  // tasks) automatically respects the scope.
  const sessionPairs = useMemo(() => {
    return visibleSessions.map((session) => {
      const task = sessionToKanbanTask(
        session,
        visitedSessions,
        manualArchivedSessionIds,
        autoArchiveTtl,
        nowTick
      );
      return {
        session,
        task: {
          ...task,
          impact: impactBySessionId.get(session.session_id),
        },
      };
    });
  }, [
    visibleSessions,
    visitedSessions,
    manualArchivedSessionIds,
    autoArchiveTtl,
    nowTick,
    impactBySessionId,
  ]);

  const sessionTasks = useMemo(
    () => sessionPairs.map((pair) => pair.task),
    [sessionPairs]
  );

  // Right edge tracks the latest session activity so the bar's "now"
  // doesn't lag behind incoming sessions. We compare against `Date.now()`
  // below so an empty board still advances.
  const latestSessionTs = useMemo(
    () =>
      sessionTasks
        .map((task) => getTaskTimestamp(task))
        .reduce((acc, ts) => Math.max(acc, ts), 0),
    [sessionTasks]
  );

  // Time-filter window is the bar's [start, end]. Recomputed whenever
  // the filter, the most-recent-session timestamp, or the periodic
  // tick changes — any of which should shift the bar's right edge.
  const bounds = useMemo(() => {
    const start = getTimeFilterCutoff(timeFilter);
    const end = Math.max(latestSessionTs, nowTick);
    return { start, end };
  }, [timeFilter, latestSessionTs, nowTick]);

  const setReplayCursor = useSetAtom(kanbanReplayCursorAtom);
  useEffect(() => {
    setReplayBounds(bounds);
    // Reclamp the cursor into the new window. Only touch it in replay
    // mode — follow mode reads `bounds.end` lazily via the resolved
    // cursor atom, so it doesn't need any explicit nudging here.
    if (
      replayMode === "replay" &&
      replayCursor !== null &&
      bounds.end > bounds.start
    ) {
      const clamped = Math.max(
        bounds.start,
        Math.min(bounds.end, replayCursor)
      );
      if (clamped !== replayCursor) setReplayCursor(clamped);
    }
  }, [bounds, replayMode, replayCursor, setReplayBounds, setReplayCursor]);

  // Sessions in the current time window. We always apply the time
  // filter — replay mode then narrows further by hiding sessions whose
  // `created_at` is past the cursor.
  const windowedPairs = useMemo(() => {
    const { start } = bounds;
    return sessionPairs.filter((pair) => getTaskTimestamp(pair.task) >= start);
  }, [sessionPairs, bounds]);

  // Event timeline (created + terminal moments) for the bar's marker
  // dots. Sourced from the time-windowed set so the bar's tick density
  // matches what the user can actually see.
  useEffect(() => {
    setReplayEvents(createReplayEvents(windowedPairs));
  }, [windowedPairs, setReplayEvents]);

  const tasks = useMemo(() => {
    const inReplay = replayMode === "replay" && replayCursor !== null;
    const recentSessionTasks: KanbanTask[] = [];
    for (const { session, task } of windowedPairs) {
      if (inReplay) {
        const projected = applyReplayCursor(task, session, replayCursor);
        if (projected) recentSessionTasks.push(projected);
      } else {
        recentSessionTasks.push(task);
      }
    }
    return recentSessionTasks;
  }, [windowedPairs, replayMode, replayCursor]);
  const groupedTasks = useMemo(() => {
    const grouped = new Map<AgentKanbanColumnId, KanbanTask[]>();
    KANBAN_COLUMNS.forEach((column) => grouped.set(column.id, []));
    tasks.forEach((task) => {
      grouped.get(task.status as AgentKanbanColumnId)?.push(task);
    });

    // Within the Archived column, surface unread cards first so freshly
    // completed but unopened sessions don't get buried by the existing
    // "all clear" pile. Stable sort: relative order of equally-unread
    // tasks (and equally-read tasks) is preserved.
    const archivedList = grouped.get("archived");
    if (archivedList && archivedList.length > 1) {
      archivedList.sort((a, b) => {
        const unreadA = a.isUnread ? 1 : 0;
        const unreadB = b.isUnread ? 1 : 0;
        if (unreadA !== unreadB) return unreadB - unreadA;
        return getTaskTimestamp(b) - getTaskTimestamp(a);
      });
    }

    return grouped;
  }, [tasks]);

  return { tasks, allTasks: sessionTasks, groupedTasks };
}
