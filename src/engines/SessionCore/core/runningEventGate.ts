import { isInteractiveTool } from "./interactiveTools";
import type { SessionEvent } from "./types";

const TERMINAL_SHELL_PROCESS_STATUSES = new Set(["exited", "killed"]);
const ACTIVE_SHELL_PROCESS_STATUSES = new Set(["running", "background"]);
const TURN_BLOCKING_SHELL_PROCESS_STATUSES = new Set(["running"]);

/**
 * Running-state gates intentionally model different product questions.
 *
 * - Live runtime resource: anything still alive or diagnostically relevant.
 *   Includes background shells and hidden status sentinels. Use for replay,
 *   planning footer, visibility filtering, dedup, and diagnostic surfaces.
 * - Composer stop-blocking work: foreground user-stoppable work only. This
 *   may hold the main composer in Stop state (Stop vs. Send icon).
 * - Timeline boundary closable event: running work that can be force-closed
 *   during stop/force-send/rewind boundary transitions.
 *
 * NONE of these gates participate in queue dispatch or submit routing — turn
 * finality is owned exclusively by the turn-lifecycle FSM
 * (`control/turnLifecycle.ts`).
 */

export function shellProcessStatusFromArgs(args: unknown): string | undefined {
  if (!args) return undefined;
  if (typeof args === "object") {
    return (args as { shellProcessStatus?: string }).shellProcessStatus;
  }
  if (typeof args !== "string") return undefined;
  try {
    const parsed = JSON.parse(args) as { shellProcessStatus?: string };
    return parsed.shellProcessStatus;
  } catch {
    return undefined;
  }
}

export function isLiveRuntimeResourceEvent(event: SessionEvent): boolean {
  const shellProcessStatus = shellProcessStatusFromArgs(event.args);
  if (
    shellProcessStatus &&
    TERMINAL_SHELL_PROCESS_STATUSES.has(shellProcessStatus)
  ) {
    return false;
  }
  return (
    event.displayStatus === "running" ||
    event.result?.status === "running" ||
    Boolean(
      shellProcessStatus &&
      ACTIVE_SHELL_PROCESS_STATUSES.has(shellProcessStatus)
    )
  );
}

/**
 * Planning-footer variant of the live-resource scan: only the LATEST turn
 * (events after the last user-source message) counts.
 *
 * Why not the whole session: zombie running events — tool calls whose
 * terminal status merge was dropped, or shell events whose
 * `shellProcessStatus` froze at "running" after the process exited — are
 * permanent once persisted. Scanning the full history lets one zombie from
 * an old turn suppress the "Planning next step…" footer for every later
 * turn in the session. Old-turn background shells (dev servers) are also
 * deliberately excluded: a pinned background process is not a reason to
 * hide "the agent is thinking".
 *
 * Within the current turn this only answers whether a live row exists; the
 * planning footer may still show after the row has been idle long enough, but
 * the watchdog must not force-complete the session while this returns true.
 *
 * `await_output` is exempt: it polls/blocks waiting for OTHER jobs (shell
 * processes, subagents) and renders as a subtle TitleOnlyBlock whose
 * shimmer is too faint to convey activity. The planning footer is a
 * better signal that the agent is still alive during a long wait_for.
 */
export function hasLiveRuntimeResourceInLatestTurn(
  events: readonly SessionEvent[]
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.source === "user") return false;
    if (isLiveRuntimeResourceEvent(event) && !isAwaitOutputEvent(event))
      return true;
  }
  return false;
}

function isAwaitOutputEvent(event: SessionEvent): boolean {
  return (
    event.functionName === "await_output" ||
    event.uiCanonical === "await_output"
  );
}

export function isTurnBlockingRuntimeEvent(event: SessionEvent): boolean {
  const shellProcessStatus = shellProcessStatusFromArgs(event.args);
  if (shellProcessStatus) {
    return TURN_BLOCKING_SHELL_PROCESS_STATUSES.has(shellProcessStatus);
  }
  return (
    event.displayStatus === "running" || event.result?.status === "running"
  );
}

export function isComposerStopBlockingEvent(event: SessionEvent): boolean {
  if (!isTurnBlockingRuntimeEvent(event)) return false;

  const shellProcessStatus = shellProcessStatusFromArgs(event.args);
  if (shellProcessStatus) {
    return TURN_BLOCKING_SHELL_PROCESS_STATUSES.has(shellProcessStatus);
  }

  return (
    event.actionType === "tool_call" || event.displayVariant === "tool_call"
  );
}

const ENGINE_ACTIVE_STATUSES = new Set([
  "running",
  "installing",
  "waiting_for_user",
  "waiting_for_funds",
]);

export function sessionHasComposerStopBlockingWork(
  events: readonly SessionEvent[],
  sessionId: string,
  runtimeStatus?: string
): boolean {
  // Stale running events in the store must not override a definitive
  // non-running runtime status. Only scan events when the runtime status
  // itself says the engine is active (or is unknown/unset).
  if (runtimeStatus !== undefined && !ENGINE_ACTIVE_STATUSES.has(runtimeStatus))
    return false;
  return events.some((event) => {
    if (event.sessionId && event.sessionId !== sessionId) return false;
    return isComposerStopBlockingEvent(event);
  });
}

export function isTimelineBoundaryClosableRuntimeEvent(
  event: SessionEvent,
  sessionId: string
): boolean {
  if (event.sessionId && event.sessionId !== sessionId) return false;
  if (!isLiveRuntimeResourceEvent(event)) return false;
  if (
    isInteractiveTool(event.functionName) ||
    isInteractiveTool(event.uiCanonical)
  ) {
    return false;
  }
  return true;
}
