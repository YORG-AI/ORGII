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
  if (!args.includes("shellProcessStatus")) return undefined;
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
 * The latest turn's live-activity classification — the SINGLE source of truth
 * for "is the agent visibly working, and does that work already show its own
 * indicator?". Both `hasLiveRuntimeResourceInLatestTurn` (watchdog input) and
 * `hasRunningAwaitWaitForInLatestTurn` (footer suppression) are derived from
 * this one scan, so they can never disagree about how `await_output` is
 * treated — the previous two-independent-scans design reasoned about
 * await_output in OPPOSITE directions (one excluded it "so the footer shows",
 * the other matched it "so the footer hides"), which only happened to compose
 * correctly. Modelling it once removes that latent conflict.
 *
 * - `idle` — no live runtime resource in the latest turn.
 * - `selfIndicating` — a running `await_output wait_for`: it renders its own
 *   live "Waiting {countdown} for …" title, which IS the activity indicator,
 *   so the planning footer would be a redundant second one.
 * - `liveSilent` — a running resource (shell, etc.) with no self-evident
 *   indicator of its own; the planning footer is the thing that conveys "still
 *   alive", so it should stay.
 *
 * Scoped to the latest turn (events after the last user-source message) to
 * avoid zombie running rows from older turns — tool calls whose terminal
 * status merge was dropped, or shells whose `shellProcessStatus` froze at
 * "running" after exit. Old-turn background shells (dev servers) are likewise
 * excluded: a pinned background process is not a reason to change the footer.
 */
export type LatestTurnActivity = "idle" | "selfIndicating" | "liveSilent";

export function classifyLatestTurnActivity(
  events: readonly SessionEvent[]
): LatestTurnActivity {
  let sawLiveSilent = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.source === "user") break;
    if (!isLiveRuntimeResourceEvent(event)) continue;
    if (isAwaitOutputEvent(event) && isAwaitWaitForCommand(event.args)) {
      // A running wait_for dominates: it self-indicates regardless of any
      // sibling silent resource, so we can stop scanning.
      return "selfIndicating";
    }
    // A running resource without its own indicator (incl. a non-wait_for
    // await_output like `monitor`, which is a quick snapshot, or a shell).
    sawLiveSilent = true;
  }
  return sawLiveSilent ? "liveSilent" : "idle";
}

/**
 * True when the latest turn has any live runtime resource — used by the
 * planning-indicator watchdog so it does not force-complete a session that is
 * genuinely still working (a long `wait_for`, a running shell, …).
 *
 * Unlike the pre-unification version, this now INCLUDES a running `wait_for`:
 * a blocked wait is genuine activity, so the watchdog should not kill it. The
 * footer is suppressed during a wait_for via `hasRunningAwaitWaitForInLatestTurn`
 * (the `selfIndicating` case), not by pretending no resource is live.
 */
export function hasLiveRuntimeResourceInLatestTurn(
  events: readonly SessionEvent[]
): boolean {
  return classifyLatestTurnActivity(events) !== "idle";
}

function isAwaitOutputEvent(event: SessionEvent): boolean {
  return (
    event.functionName === "await_output" ||
    event.uiCanonical === "await_output"
  );
}

/**
 * True when the latest turn's activity is self-indicating — i.e. a still-running
 * `await_output wait_for` whose own "Waiting {countdown} for …" title already
 * conveys "the agent is alive and blocked on a job". Callers suppress the
 * planning footer in this window so the user does not see two stacked waiting
 * indicators for the same wait. `monitor`/`list` are non-blocking snapshots and
 * never self-indicate, so the footer still shows for them.
 */
export function hasRunningAwaitWaitForInLatestTurn(
  events: readonly SessionEvent[]
): boolean {
  return classifyLatestTurnActivity(events) === "selfIndicating";
}

/**
 * Resolve whether an `await_output` event is a blocking `wait_for` call.
 * Mirrors the adapter's `resolveAwaitCommand` inference: explicit `command`
 * wins; otherwise a present `pattern`/`wait_mode` implies `wait_for`.
 */
function isAwaitWaitForCommand(args: unknown): boolean {
  const parsed: Record<string, unknown> | undefined =
    typeof args === "string"
      ? (() => {
          try {
            return JSON.parse(args) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })()
      : (args as Record<string, unknown> | undefined);
  if (!parsed) return false;
  const command = parsed.command;
  if (typeof command === "string" && command.length > 0) {
    return command === "wait_for";
  }
  const hasPattern = parsed.pattern !== undefined && parsed.pattern !== null;
  const hasWaitMode =
    parsed.wait_mode !== undefined && parsed.wait_mode !== null;
  return hasPattern || hasWaitMode;
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

  // isTurnBlockingRuntimeEvent already validated the shell process status; if
  // shellProcessStatus is present the event is a turn-blocking shell — it is
  // always stop-blocking. Only fall through to the tool_call check for events
  // whose blocking status comes from displayStatus / result.status instead.
  if (shellProcessStatusFromArgs(event.args)) return true;

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
