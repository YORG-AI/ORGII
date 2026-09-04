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
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom, visitedSessionsAtom } from "@src/store/session";
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
import { useKanbanNowTick } from "./useKanbanNowTick";
import {
  resolveKanbanTaskCreator,
  sessionMatchesKanbanOrgScope,
  useKanbanOrgScope,
} from "./useKanbanOrgScope";
import { buildCloudRemoteKanbanProjection } from "./useKanbanTasks/cloudRemoteToKanbanTask";
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
  /** Follow the organization selected in the Workstation sidebar. */
  followSidebarOrgScope?: boolean;
}

export interface UseKanbanTasksReturn {
  tasks: KanbanTask[];
  allTasks: KanbanTask[];
  groupedTasks: Map<AgentKanbanColumnId, KanbanTask[]>;
  cloudOrgId: string | null;
  remoteSessionsByTaskId: ReadonlyMap<string, RemoteTeammateSessionMetadata>;
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
    followSidebarOrgScope = true,
  } = options;
  const sessions = useAtomValue(sessionsAtom);
  const orgScope = useKanbanOrgScope(sessions, followSidebarOrgScope);
  // Team-scoped embeds already provide an explicit local session allowlist;
  // the global cloud roster must not leak into those narrower boards.
  const cloudOrgId = sessionIdFilter ? null : (orgScope?.cloudOrgId ?? null);
  const { rows: cloudRemoteSessions } = useCloudOrgRemoteSessions(cloudOrgId);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const manualArchivedSessionIds = useAtomValue(
    kanbanManualArchivedSessionsAtom
  );
  // 30s is enough for time-window boundaries. The owner pauses while hidden,
  // refreshes once on return, and never overlaps timers.
  const nowTick = useKanbanNowTick();

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
            (!sessionIdFilter || sessionIdFilter.has(session.session_id)) &&
            sessionMatchesKanbanOrgScope(session, orgScope)
        )
      ),
    [orgScope, sessions, sessionIdFilter]
  );
  const { impactBySessionId } = useSessionImpact(visibleSessions);

  // Project sessions once. The scope filter above owns which local sessions
  // are eligible for every downstream board/list concern.
  const localTasks = useMemo(() => {
    return visibleSessions.map((session) => {
      const task = sessionToKanbanTask(
        session,
        visitedSessions,
        manualArchivedSessionIds,
        autoArchiveTtl,
        nowTick
      );
      return {
        ...task,
        impact: impactBySessionId.get(session.session_id),
        createdBy: resolveKanbanTaskCreator(session, orgScope),
      };
    });
  }, [
    visibleSessions,
    visitedSessions,
    manualArchivedSessionIds,
    autoArchiveTtl,
    nowTick,
    impactBySessionId,
    orgScope,
  ]);

  const cloudProjection = useMemo(
    () =>
      cloudOrgId
        ? buildCloudRemoteKanbanProjection(
            cloudRemoteSessions,
            visibleSessions,
            {
              orgId: cloudOrgId,
              viewerUserId: orgScope?.cloudViewerUserId,
              autoArchiveTtl,
              nowMs: nowTick,
            }
          )
        : {
            tasks: [] as KanbanTask[],
            remoteSessionsByTaskId: new Map<
              string,
              RemoteTeammateSessionMetadata
            >(),
          },
    [
      autoArchiveTtl,
      cloudOrgId,
      cloudRemoteSessions,
      nowTick,
      orgScope?.cloudViewerUserId,
      visibleSessions,
    ]
  );
  const allTasks = useMemo(
    () => [...localTasks, ...cloudProjection.tasks],
    [cloudProjection.tasks, localTasks]
  );

  // Recompute the moving time-window boundary whenever the visibility-aware
  // clock ticks, so sessions age out without requiring other store activity.
  const timeFilterCutoff = useMemo(
    () => getTimeFilterCutoff(timeFilter, nowTick),
    [nowTick, timeFilter]
  );

  // Sessions in the current time window.
  const windowedLocalTasks = useMemo(() => {
    return localTasks.filter(
      (task) => getTaskTimestamp(task) >= timeFilterCutoff
    );
  }, [localTasks, timeFilterCutoff]);
  const windowedRemoteTasks = useMemo(() => {
    return cloudProjection.tasks.filter(
      (task) => getTaskTimestamp(task) >= timeFilterCutoff
    );
  }, [cloudProjection.tasks, timeFilterCutoff]);

  const tasks = useMemo(() => {
    return [...windowedLocalTasks, ...windowedRemoteTasks];
  }, [windowedLocalTasks, windowedRemoteTasks]);
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

  return {
    tasks,
    allTasks,
    groupedTasks,
    cloudOrgId,
    remoteSessionsByTaskId: cloudProjection.remoteSessionsByTaskId,
  };
}
