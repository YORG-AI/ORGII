import { useEffect, useMemo, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isExternalHistorySession } from "@src/util/session/sessionDispatch";
import { isSessionInProgress } from "@src/util/session/sessionInProgress";

import type { GroupChatContextValue } from "../GroupChatView/GroupChatContext";
import { isAgentOrgInboxTranscriptEvent } from "../GroupChatView/groupChatUtils";
import type { TailTurnPhase } from "./useChatGroupsProjection";

/**
 * A session whose last event is older than this is treated as finished: its
 * tail turn DEFAULTS to collapsed, matching historical turns. Explicit
 * per-turn overrides still win.
 */
export const TAIL_TURN_STALE_MS = 10 * 60_000;

export function findTailTurnId(
  chatHistory: SessionEvent[],
  groupChat: GroupChatContextValue | null
): string | null {
  for (let index = chatHistory.length - 1; index >= 0; index--) {
    const event = chatHistory[index];
    if (!event?.id) continue;
    if (groupChat?.enabled) {
      if (groupChat.isCoordinatorTurnHeader(event)) return event.id;
      continue;
    }
    if (event.source === "user" && !isAgentOrgInboxTranscriptEvent(event)) {
      return event.id;
    }
  }
  return null;
}

interface ResolveTailTurnAgentWorkingOptions {
  activeId: string | null;
  isAgentWorking: boolean;
  sessionStatus: string | undefined;
}

/**
 * External-history rows get their live state from the normalized Session
 * status that also drives the sidebar dot. The foreground runtime atom is
 * authoritative for native sessions, but it does not track an independently
 * running Codex/Claude process.
 */
export function resolveTailTurnAgentWorking({
  activeId,
  isAgentWorking,
  sessionStatus,
}: ResolveTailTurnAgentWorkingOptions): boolean {
  if (!isExternalHistorySession(activeId)) return isAgentWorking;
  return isSessionInProgress(sessionStatus);
}

/**
 * How long until the tail turn goes stale, floored at zero.
 *
 * A session reopened long after its last event is already past the window,
 * which would otherwise be a synchronous state write from the effect body
 * (cascading render). Clamping to zero routes that case through the same
 * timer as a live session — one macrotask later instead of the same commit.
 */
export function resolveTailTurnStaleDelayMs(
  lastEventMs: number,
  nowMs: number
): number {
  return Math.max(lastEventMs + TAIL_TURN_STALE_MS - nowMs, 0);
}

interface UseTailTurnPhaseOptions {
  activeId: string | null;
  chatHistory: SessionEvent[];
  disableTailCollapse: boolean;
  groupChat: GroupChatContextValue | null;
  isAgentWorking: boolean;
  sessionStatus: string | undefined;
}

/**
 * The tail turn's lifecycle phase, driving exactly two collapse rules:
 *
 * - `"complete"` — the round ended: the "Agent worked for X" bar may render
 *   (no wait, no size threshold) while the turn stays expanded by default.
 *   LATCHED per `${activeId}:${tailTurnId}`: a raw `!agentWorking` read
 *   flickers, because every dispatch writes an optimistic `running` status
 *   BEFORE the user-message event lands (`optimisticTurnStatus.ts` ordering
 *   invariant), so the finished round is briefly still the tail group when
 *   the signal flips false and its bar would unmount until the projection
 *   regroups. Watched external CLI sessions have the same
 *   status-before-transcript gap; session-switch status resets and
 *   background-subagent signal edges add more. Once a tail turn is observed
 *   complete it stays complete until the tail moves to a new turn, which
 *   always starts unlatched.
 * - `"stale"` — the newest event is older than `TAIL_TURN_STALE_MS`: the
 *   session most likely finished, so the tail also DEFAULTS to collapsed
 *   like a historical turn. Requires completion first, so a hung-but-working
 *   agent never folds its own in-flight round; any new event re-arms the
 *   clock.
 *
 * Always `"running"` under `disableTailCollapse` (subagent cells).
 */
export function useTailTurnPhase({
  activeId,
  chatHistory,
  disableTailCollapse,
  groupChat,
  isAgentWorking,
  sessionStatus,
}: UseTailTurnPhaseOptions): TailTurnPhase {
  const [completeLatchKey, setCompleteLatchKey] = useState<string | null>(null);
  const [staleReadyKey, setStaleReadyKey] = useState<string | null>(null);

  const tailTurnId = useMemo(
    () => findTailTurnId(chatHistory, groupChat),
    [chatHistory, groupChat]
  );
  const lastEventMs = useMemo(() => {
    for (let index = chatHistory.length - 1; index >= 0; index--) {
      const iso = chatHistory[index]?.createdAt;
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  }, [chatHistory]);
  const agentWorking = resolveTailTurnAgentWorking({
    activeId,
    isAgentWorking,
    sessionStatus,
  });

  const turnKey =
    !disableTailCollapse && activeId && tailTurnId
      ? `${activeId}:${tailTurnId}`
      : null;
  const staleKey =
    !disableTailCollapse && activeId && lastEventMs !== null
      ? `${activeId}:${lastEventMs}`
      : null;
  const completeNow = turnKey !== null && !agentWorking;

  useEffect(() => {
    if (!completeNow || turnKey === null) return;

    // Routed through a zero-delay timer for the same reason the stale effect
    // below is: a synchronous set from an effect body is a cascading render
    // (react-hooks/set-state-in-effect). The latch lands one macrotask after
    // the "complete" render commits; a complete→running flip inside that
    // same macrotask loses the latch, but a bar that never survived a single
    // frame has nothing visible to preserve.
    const timeoutId = window.setTimeout(() => {
      setCompleteLatchKey(turnKey);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [completeNow, turnKey]);

  useEffect(() => {
    if (!staleKey || lastEventMs === null) return;

    const timeoutId = window.setTimeout(
      () => {
        setStaleReadyKey(staleKey);
      },
      resolveTailTurnStaleDelayMs(lastEventMs, Date.now())
    );

    return () => window.clearTimeout(timeoutId);
  }, [staleKey, lastEventMs]);

  const complete =
    completeNow || (turnKey !== null && completeLatchKey === turnKey);
  if (!complete) return "running";
  return staleKey !== null && staleReadyKey === staleKey ? "stale" : "complete";
}
