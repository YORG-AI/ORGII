import { CANCEL_REASON } from "@src/api/tauri/agent";
import {
  beginTurnStopping,
  forceTurnIdle,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { isTimelineBoundaryClosableRuntimeEvent } from "@src/engines/SessionCore/core/runningEventGate";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { markSessionStreamingStopped } from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/streamHelpers";
import { createLogger } from "@src/hooks/logger";
import { killAgentShellProcess } from "@src/services/terminal";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRuntimeStatusAtom,
  setSessionRuntimeStatusAtom,
  streamRetryStatusAtom,
  userInitiatedCancelAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { shellProcessMapAtom } from "@src/store/session/shellProcessAtom";
import { holdSessionQueueForStopAtom } from "@src/store/ui/messageQueueAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { streamingDeltaContentAtom } from "../core/atoms";

export type TimelineBoundaryReason = "stop" | "force-send" | "rewind";

/**
 * Which OS shell processes a boundary terminates.
 *  - "none":       leave all shells running (rewind: the timeline is being
 *                  rewritten, not stopped).
 *  - "foreground": kill running foreground shells, keep background workers
 *                  (force-send: interrupt the current work but let long-running
 *                  background processes / dev servers survive the follow-up).
 *  - "all":        kill foreground + background (stop: user wants everything
 *                  this session spawned to halt).
 */
type ShellKillScope = "none" | "foreground" | "all";

interface TimelineBoundaryEffect {
  /** Drive the FSM to "stopping" (interrupt) vs "idle" (rewind rewrite). */
  forcesIdle: boolean;
  /** Explicit user Stop — parks the queue and sets the cancel atoms. */
  isUserStop: boolean;
  /** Which OS shell processes to terminate at this boundary. */
  shellKill: ShellKillScope;
}

/**
 * Single source of truth for every boundary's side-effects. Mirrors the
 * backend's `CancelReason::boundary_effect()` struct: a new
 * `TimelineBoundaryReason` cannot compile without declaring its policy here,
 * so it can never silently inherit the wrong shell-kill / FSM behavior. That
 * latent-discipline gap (an inline `if (isUserStop)` that only Stop satisfied)
 * is exactly what let force-send leave a blocking foreground shell alive and
 * swallow the follow-up message (issue #110).
 */
export const BOUNDARY_EFFECTS: Record<
  TimelineBoundaryReason,
  TimelineBoundaryEffect
> = {
  stop: { forcesIdle: false, isUserStop: true, shellKill: "all" },
  "force-send": {
    forcesIdle: false,
    isUserStop: false,
    shellKill: "foreground",
  },
  rewind: { forcesIdle: true, isUserStop: false, shellKill: "none" },
};

const log = createLogger("sessionTimelineBoundary");

const interruptInFlightByBoundary = new Set<string>();

function boundaryKey(
  sessionId: string,
  reason: TimelineBoundaryReason
): string {
  return `${reason}:${sessionId}`;
}

function reasonToCancelReason(reason: TimelineBoundaryReason) {
  return reason === "force-send"
    ? CANCEL_REASON.FORCE_SEND
    : CANCEL_REASON.USER_STOP;
}

export function clearLiveStreamingForSession(sessionId: string): void {
  const store = getInstrumentedStore();
  markSessionStreamingStopped(sessionId);
  store.set(streamRetryStatusAtom, null);
  store.set(streamingDeltaContentAtom, (prev) => {
    if (!prev.has(sessionId)) return prev;
    const next = new Map(prev);
    next.delete(sessionId);
    return next;
  });
}

async function killShellProcessesForBoundary(
  sessionId: string,
  scope: ShellKillScope
): Promise<void> {
  if (scope === "none") return;
  const processes = getInstrumentedStore()
    .get(shellProcessMapAtom)
    .get(sessionId);
  if (!processes) return;

  await Promise.allSettled(
    [...processes.values()]
      .filter((process) =>
        scope === "all"
          ? process.status === "running" || process.status === "background"
          : process.status === "running"
      )
      .map((process) => killAgentShellProcess({ pid: process.pid, sessionId }))
  );
}

async function closeRunningEventsForTimelineBoundary(
  sessionId: string,
  reason: TimelineBoundaryReason
): Promise<void> {
  const events = await eventStoreProxy.getEvents(sessionId);
  const runningEventIds = events
    .filter((event) => isTimelineBoundaryClosableRuntimeEvent(event, sessionId))
    .map((event) => event.id);
  if (runningEventIds.length === 0) return;

  await eventStoreProxy.patchByIds(
    runningEventIds,
    {
      displayStatus: reason === "rewind" ? "completed" : "failed",
      activityStatus: "processed",
    },
    sessionId
  );
}

function shouldInterruptForTimelineBoundary(
  _sessionId: string,
  reason: TimelineBoundaryReason
): boolean {
  if (reason !== "rewind") return true;

  const store = getInstrumentedStore();
  const runtimeStatus = store.get(sessionRuntimeStatusAtom);
  return (
    store.get(isSessionActiveAtom) ||
    runtimeStatus === "running" ||
    runtimeStatus === "installing"
  );
}

export function beginTimelineBoundary(
  sessionId: string,
  reason: TimelineBoundaryReason
): void {
  const store = getInstrumentedStore();
  const effect = BOUNDARY_EFFECTS[reason];

  // Drive the turn-lifecycle FSM first so any submit/dispatch racing this
  // boundary already observes the new phase.
  // - stop / force-send (forcesIdle:false): the turn stays blocked
  //   ("stopping") until the provider confirms the cancel with a terminal
  //   (bounded by the FSM's stopping dead-man).
  // - rewind (forcesIdle:true): the timeline is being rewritten — force idle
  //   immediately and invalidate any in-flight terminal of the overridden turn.
  if (effect.forcesIdle) {
    forceTurnIdle(sessionId);
  } else {
    beginTurnStopping(sessionId);
  }

  if (effect.isUserStop) {
    store.set(userInitiatedCancelAtom, true);
    store.set(isPendingCancelAtom, true);
    // Stop parks every queued follow-up of this session: the natural drain
    // skips them permanently; only an explicit Send Now dispatches them.
    store.set(holdSessionQueueForStopAtom, sessionId);
  } else {
    store.set(userInitiatedCancelAtom, false);
    store.set(isPendingCancelAtom, false);
  }

  clearLiveStreamingForSession(sessionId);
  // Shell-kill scope is declared per-boundary in BOUNDARY_EFFECTS:
  //   stop="all", force-send="foreground", rewind="none". Killing the
  //   blocking foreground shell on force-send is the #110 fix — it lets the
  //   provider deliver the cancelled terminal promptly so the FSM flips idle
  //   and the queued Send-Now message dispatches, instead of stalling until
  //   the command finishes on its own.
  void killShellProcessesForBoundary(sessionId, effect.shellKill).catch(
    (error) => {
      log.warn(
        "[sessionTimelineBoundary] failed to kill shell processes",
        error
      );
    }
  );
  // All boundary causes close the interrupted turn's running events. For
  // force-send this is what clears stale `displayStatus:"running"` rows that
  // would otherwise keep `anyRunning` true in usePlanningIndicator and
  // suppress the planning footer after the redispatch. Idempotent with the
  // provider terminal's own close (rendered-status merge tolerates it).
  void closeRunningEventsForTimelineBoundary(sessionId, reason).catch(
    (error) => {
      log.warn(
        "[sessionTimelineBoundary] failed to close running events",
        error
      );
    }
  );
  if (reason === "force-send") {
    // Send Now guarantees a redispatch the moment the provider confirms the
    // cancel — from the user's point of view the turn continues. Writing
    // `idle` here blanked the planning footer for the whole interrupt window
    // (the "force-send looks stuck" bug); keep the status mirror `running`
    // and let the redispatch / terminal own the next transition.
    return;
  }
  store.set(setSessionRuntimeStatusAtom, {
    sessionId,
    status: "idle",
    source: "timeline-boundary",
  });
}

export function beginStopBoundary(sessionId: string): void {
  beginTimelineBoundary(sessionId, "stop");
}

export function isTimelineInterruptInFlight(
  sessionId: string,
  reason: TimelineBoundaryReason
): boolean {
  return interruptInFlightByBoundary.has(boundaryKey(sessionId, reason));
}

export async function cancelTurnForTimelineBoundary(
  sessionId: string,
  reason: TimelineBoundaryReason,
  options: { onError?: (message: string) => void } = {}
): Promise<void> {
  beginTimelineBoundary(sessionId, reason);
  if (!shouldInterruptForTimelineBoundary(sessionId, reason)) return;
  const key = boundaryKey(sessionId, reason);
  if (interruptInFlightByBoundary.has(key)) return;
  interruptInFlightByBoundary.add(key);
  try {
    await SessionService.interrupt({
      sessionId,
      reason: reasonToCancelReason(reason),
      onError: options.onError,
    });
  } catch (error) {
    log.warn("[sessionTimelineBoundary] interrupt failed", error);
    if (options.onError) {
      options.onError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    interruptInFlightByBoundary.delete(key);
  }
}
