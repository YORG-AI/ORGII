/**
 * useSimulatorSubagents
 *
 * Manages subagent child session state for ActivitySimulator:
 * - Queries DB for child sessions (re-fetches on eventStoreVersion change)
 * - Computes cursor-active subagents for the split pane
 * - Syncs allSubagentSessions to simulatorSubagentSessionsAtom (for
 *   SessionReplayMessages SubagentChip rows, without prop drilling)
 * - Manages split pane dismiss/reveal state
 *
 * Bug 5 note: trigger is eventStoreVersion (not event_count / events.length).
 * See docs/agent/subagent-rendering-bug--0417.md § Bug 5 for the
 * full root-cause chain. Do NOT change the trigger without reading that doc.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore";
import { replayModeAtom } from "@src/engines/SessionCore";
import {
  focusedSubagentCellAtom,
  simulatorSubagentSessionsAtom,
  subagentPanelRevealRequestAtom,
} from "@src/store/ui/simulatorAtom";

import { useSubagentEventCounts } from "./useSubagentEventCounts";
import type { SubagentSession } from "./useSubagentSessions";
import {
  useActiveSubagentsAtCursor,
  useSubagentSessions,
} from "./useSubagentSessions";

interface UseSimulatorSubagentsOptions {
  sessionId: string;
  eventStoreVersion: number;
  currentEvent: SessionEvent | null;
  allEvents: SessionEvent[];
  enabled?: boolean;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function subagentIdFromEvent(event: SessionEvent): string | null {
  const isSubagentTool =
    event.actionType === "tool_call" &&
    (event.functionName === "subagent" || event.uiCanonical === "subagent");
  if (!isSubagentTool) {
    return null;
  }
  return (
    nonEmptyString(event.args?.subagentSessionId) ??
    nonEmptyString(event.result?.subagentSessionId)
  );
}

function taskTitleFromEvent(event: SessionEvent, sessionId: string): string {
  return (
    nonEmptyString(event.args?.prompt) ??
    nonEmptyString(event.args?.description) ??
    nonEmptyString(event.result?.summary) ??
    nonEmptyString(event.result?.content) ??
    sessionId
  );
}

function fallbackSubagentSessionsFromEvents(
  events: readonly SessionEvent[]
): SubagentSession[] {
  const sessions = new Map<string, SubagentSession>();
  for (const event of events) {
    const sessionId = subagentIdFromEvent(event);
    if (!sessionId || sessions.has(sessionId)) continue;
    const createdMs = new Date(event.createdAt).getTime();
    const safeCreatedMs = Number.isFinite(createdMs) ? createdMs : Date.now();
    const isCompleted =
      event.displayStatus === "completed" ||
      event.activityStatus === "processed";
    const isFailed = event.displayStatus === "failed";
    sessions.set(sessionId, {
      key: sessionId,
      sessionId,
      name: "OpenCode",
      description: taskTitleFromEvent(event, sessionId),
      sessionType: "subagent",
      status: isFailed ? "failed" : isCompleted ? "completed" : "running",
      isBackground: true,
      startedAtMs: safeCreatedMs,
      endedAtMs: isCompleted || isFailed ? safeCreatedMs : null,
      isTerminal: isCompleted || isFailed,
    });
  }
  return Array.from(sessions.values());
}

export interface UseSimulatorSubagentsReturn {
  allSubagentSessions: SubagentSession[];
  activeSubagents: SubagentSession[];
  hasActiveSubagents: boolean;
  handleSubagentPanelClose: () => void;
}

export function useSimulatorSubagents({
  sessionId,
  eventStoreVersion,
  currentEvent,
  allEvents,
  enabled = true,
}: UseSimulatorSubagentsOptions): UseSimulatorSubagentsReturn {
  const panelRevealRequest = useAtomValue(subagentPanelRevealRequestAtom);
  const focusedCellId = useAtomValue(focusedSubagentCellAtom);
  const setFocusedCellId = useSetAtom(focusedSubagentCellAtom);
  const replayMode = useAtomValue(replayModeAtom);
  const [dismissedSnapshot, setDismissedSnapshot] = useState<{
    keys: string;
    reveal: number;
  } | null>(null);

  // Focus lifecycle: the locate arrow (SubagentAdapter.handleNavigate) seeks
  // the main cursor into the subagent's clip window and pins the cell via
  // focusedSubagentCellAtom — that pin is only meant for the free-browse
  // (replay) session it started. Returning to "Following Agent" means the
  // user is done inspecting history, so release the pin; otherwise the
  // focused cell is force-prepended forever and never retires with the
  // timeline. (No other code path clears this atom.)
  useEffect(() => {
    if (replayMode === "follow" && focusedCellId !== null) {
      setFocusedCellId(null);
    }
  }, [replayMode, focusedCellId, setFocusedCellId]);

  // DB query — re-triggered by eventStoreVersion (bumped on every EventStore
  // mutation, including args patches like stamp_subagent_session_id_on_parent).
  const dbSubagentSessions = useSubagentSessions(
    enabled ? sessionId || null : null,
    eventStoreVersion
  );
  const eventSubagentSessions = useMemo(
    () => (enabled ? fallbackSubagentSessionsFromEvents(allEvents) : []),
    [allEvents, enabled]
  );
  const allSubagentSessions = useMemo(() => {
    if (eventSubagentSessions.length === 0) return dbSubagentSessions;
    const byId = new Map(dbSubagentSessions.map((sub) => [sub.sessionId, sub]));
    for (const fallback of eventSubagentSessions) {
      if (!byId.has(fallback.sessionId)) {
        byId.set(fallback.sessionId, fallback);
      }
    }
    return Array.from(byId.values());
  }, [dbSubagentSessions, eventSubagentSessions]);

  // Sync to atom so SessionReplayMessages can read without prop drilling.
  // Cleanup clears the atom when ActivitySimulator unmounts so stale sessions
  // never leak into the next mounted session.
  const setSimulatorSubagentSessions = useSetAtom(
    simulatorSubagentSessionsAtom
  );
  useEffect(() => {
    setSimulatorSubagentSessions(allSubagentSessions);
    return () => {
      setSimulatorSubagentSessions([]);
    };
  }, [allSubagentSessions, setSimulatorSubagentSessions]);

  // Filter to sessions whose time-window covers the current replay cursor,
  // then UNION with clips that are still OPEN (endedAtMs === null, i.e.
  // running right now). The union fixes two gaps:
  //   - a freshly spawned subagent is visible even while the main cursor
  //     lags behind its startedAtMs (the spawning tool_call is filtered
  //     from the slider);
  //   - in live-follow, a running worker stays visible even after a fast
  //     sibling finished and pulled the parent cursor past its own window.
  // Closed clips deliberately do NOT resurface — once the cursor passes a
  // clip's end AND it is no longer open, its cell retires from the monitor.
  // (The old fall-back-to-everything behavior is what made cells
  // accumulate; a union of cursor-active + still-open keeps that fix.)
  const cursorActiveSubagents = useActiveSubagentsAtCursor(
    allSubagentSessions,
    currentEvent
  );
  const openSubagents = useMemo(
    () => allSubagentSessions.filter((sub) => sub.endedAtMs === null),
    [allSubagentSessions]
  );
  // Imported OpenCode subagent history is already completed by the time it
  // shows up in the simulator. Only resurface a completed clip when the replay
  // cursor is on that subagent delegate event; once the cursor moves past the
  // clip, terminal DB-backed clips must still retire like native SDE subagents.
  const currentEventSubagentId = useMemo(
    () => (currentEvent ? subagentIdFromEvent(currentEvent) : null),
    [currentEvent]
  );
  const currentEventCompletedSubagent = useMemo(() => {
    if (!currentEventSubagentId) return [];
    const sub = allSubagentSessions.find(
      (session) =>
        session.sessionId === currentEventSubagentId &&
        session.endedAtMs !== null
    );
    return sub ? [sub] : [];
  }, [allSubagentSessions, currentEventSubagentId]);
  // A subagent the user explicitly navigated to (clicked the chat block's
  // locate arrow) must surface even when the replay cursor doesn't land inside
  // its clip window. The spawning tool_call is filtered out of the simulator
  // event list, so seeking the cursor to it resolves to a neighbour outside
  // the window — focus is the authoritative "show this one" signal, so honour
  // it directly instead of depending on the (substituted) cursor event.
  const focusedSubagent = useMemo(
    () =>
      focusedCellId
        ? (allSubagentSessions.find((sub) => sub.sessionId === focusedCellId) ??
          null)
        : null,
    [allSubagentSessions, focusedCellId]
  );
  const baseSubagents = useMemo(() => {
    const byId = new Map<string, SubagentSession>();

    for (const sub of cursorActiveSubagents) {
      byId.set(sub.sessionId, sub);
    }
    for (const sub of openSubagents) {
      if (!byId.has(sub.sessionId)) {
        byId.set(sub.sessionId, sub);
      }
    }
    for (const sub of currentEventCompletedSubagent) {
      if (!byId.has(sub.sessionId)) {
        byId.set(sub.sessionId, sub);
      }
    }

    return Array.from(byId.values());
  }, [cursorActiveSubagents, openSubagents, currentEventCompletedSubagent]);
  const cursorOrAllSubagents = useMemo(() => {
    if (!focusedSubagent) return baseSubagents;
    if (
      baseSubagents.some((sub) => sub.sessionId === focusedSubagent.sessionId)
    )
      return baseSubagents;
    return [focusedSubagent, ...baseSubagents];
  }, [baseSubagents, focusedSubagent]);

  // Subscribe (count-only) to every subagent's EventStore so we can rank
  // "has activity" rows ahead of "no activity" rows BEFORE the consumer
  // (SubagentPipCard / BackgroundTasksApp) paginates the list. Without
  // this, the DB-status ordering from useSubagentSessions is the only
  // signal — and a subagent with status="running" but zero events still
  // lands on page 1, pushing a populated subagent onto page 2.
  const subagentCountMap = useSubagentEventCounts(cursorOrAllSubagents);

  const activeSubagents = useMemo(() => {
    if (cursorOrAllSubagents.length <= 1) return cursorOrAllSubagents;
    // Stable sort: rows with chatEvents > 0 first, zero-event rows last.
    // Within each group preserve original index so a single count change
    // doesn't reshuffle unrelated cells.
    const indexById = new Map(
      cursorOrAllSubagents.map((sub, index) => [sub.sessionId, index])
    );
    const ranked = cursorOrAllSubagents.slice();
    ranked.sort((left, right) => {
      const leftHas = (subagentCountMap.get(left.sessionId) ?? 0) > 0;
      const rightHas = (subagentCountMap.get(right.sessionId) ?? 0) > 0;
      if (leftHas === rightHas) {
        return (
          (indexById.get(left.sessionId) ?? 0) -
          (indexById.get(right.sessionId) ?? 0)
        );
      }
      return leftHas ? -1 : 1;
    });
    return ranked;
  }, [cursorOrAllSubagents, subagentCountMap]);

  const activeSubagentKeys = activeSubagents.map((sub) => sub.key).join(",");

  const handleSubagentPanelClose = useCallback(() => {
    setDismissedSnapshot({
      keys: activeSubagentKeys,
      reveal: panelRevealRequest,
    });
  }, [activeSubagentKeys, panelRevealRequest]);

  // Panel re-opens when either the key set or the reveal counter changes.
  const isPanelDismissed =
    dismissedSnapshot !== null &&
    dismissedSnapshot.keys === activeSubagentKeys &&
    dismissedSnapshot.reveal === panelRevealRequest;

  const hasActiveSubagents = activeSubagents.length > 0 && !isPanelDismissed;

  return {
    allSubagentSessions,
    activeSubagents,
    hasActiveSubagents,
    handleSubagentPanelClose,
  };
}
