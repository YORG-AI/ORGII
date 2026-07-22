/**
 * Turn Lifecycle FSM — the single authority for "is a turn active for this
 * session, and has the provider delivered this turn's final terminal yet".
 *
 * ```
 * idle ──beginTurnDispatch──▶ dispatching ──running ack──▶ working
 *   ▲                             │                          │
 *   │                             │ user Stop                │ user Stop
 *   │                             ▼                          ▼
 *   └──◀── provider terminal ── stopping ◀──────────────────┘
 * ```
 *
 * Only two kinds of input drive this machine:
 *   1. Explicit user actions — `beginTurnDispatch` (send a prompt),
 *      `beginTurnStopping` (Stop / Send Now interrupt), `forceTurnIdle`
 *      (rewind boundary / bounded fallbacks).
 *   2. Provider signals routed through the adapters —
 *      `markTurnRunning` / `confirmTurnRunning` (running ack) and
 *      `markTurnTerminal` (this turn's final completed/failed/cancelled).
 *
 * Anything else — runtime-status atoms, rendered events, streaming deltas,
 * heuristic timestamps — is presentation state and MUST NOT be consulted for
 * queueing decisions. `sessionRuntimeStatusAtom` is a UI mirror only.
 *
 * Invariants:
 *   - Every dispatch bumps `generation` synchronously (the reserve), so two
 *     concurrent submits can never both see "idle".
 *   - A terminal carrying a generation that does not match the current one is
 *     discarded — a late terminal from an old turn can never release the
 *     queue for a newer turn.
 *   - A terminal without a generation is discarded while "dispatching"
 *     (before the running ack, any unattributed terminal is by definition
 *     from an older turn).
 *   - "dispatching" and "stopping" are user-facing lock states and therefore
 *     time-bounded by dead-man timers; "working" is provider-owned and
 *     unbounded.
 */
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

const log = createLogger("turnLifecycle");

export type TurnPhase = "idle" | "dispatching" | "working" | "stopping";

export type TurnTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * Normalize the many provider/backend terminal status strings into the three
 * FSM terminal statuses. Unknown terminal-ish statuses normalize to
 * "completed" — for queueing purposes all terminals behave identically; the
 * distinction only matters for diagnostics.
 */
export function toTurnTerminalStatus(status: string): TurnTerminalStatus {
  if (status === "failed" || status === "error" || status === "timeout") {
    return "failed";
  }
  if (status === "cancelled" || status === "abandoned") {
    return "cancelled";
  }
  return "completed";
}

interface SessionTurnState {
  phase: TurnPhase;
  generation: number;
  lastTerminal: {
    generation: number;
    status: TurnTerminalStatus;
    at: number;
  } | null;
  deadmanTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * If a dispatch never receives a running ack (backend hung before accepting
 * the turn), unlock after this bound instead of blocking the composer forever.
 */
const DISPATCHING_DEADMAN_MS = 60_000;

/**
 * If a Stop / Send Now interrupt never receives the cancelled/failed terminal
 * (provider had nothing to cancel, or the event was dropped), unlock after
 * this bound. Mirrors the legacy 10s stop fallback in useSessionActions.
 */
const STOPPING_DEADMAN_MS = 10_000;

/** Bumped on every phase transition so the queue dispatcher can subscribe. */
export const turnLifecycleSignalAtom = atom(0);
turnLifecycleSignalAtom.debugLabel = "turnLifecycleSignalAtom";

const stateBySession = new Map<string, SessionTurnState>();

function getState(sessionId: string): SessionTurnState {
  let state = stateBySession.get(sessionId);
  if (!state) {
    state = {
      phase: "idle",
      generation: 0,
      lastTerminal: null,
      deadmanTimer: null,
    };
    stateBySession.set(sessionId, state);
  }
  return state;
}

function bumpSignal(): void {
  if (!isStoreInitialized()) return;
  getInstrumentedStore().set(turnLifecycleSignalAtom, (n) => n + 1);
}

function clearDeadman(state: SessionTurnState): void {
  if (state.deadmanTimer !== null) {
    clearTimeout(state.deadmanTimer);
    state.deadmanTimer = null;
  }
}

function armDeadman(
  sessionId: string,
  state: SessionTurnState,
  phase: TurnPhase,
  timeoutMs: number
): void {
  clearDeadman(state);
  const armedGeneration = state.generation;
  state.deadmanTimer = setTimeout(() => {
    const current = stateBySession.get(sessionId);
    if (
      !current ||
      current.phase !== phase ||
      current.generation !== armedGeneration
    ) {
      return;
    }
    log.warn(
      `[turnLifecycle] dead-man: session ${sessionId} stuck in "${phase}" for ` +
        `${timeoutMs}ms (generation ${armedGeneration}) — forcing idle`
    );
    forceTurnIdle(sessionId);
  }, timeoutMs);
}

function transition(
  sessionId: string,
  state: SessionTurnState,
  phase: TurnPhase
): void {
  if (state.phase === phase) return;
  state.phase = phase;
  clearDeadman(state);
  if (phase === "dispatching") {
    armDeadman(sessionId, state, "dispatching", DISPATCHING_DEADMAN_MS);
  } else if (phase === "stopping") {
    armDeadman(sessionId, state, "stopping", STOPPING_DEADMAN_MS);
  }
  bumpSignal();
}

/**
 * Synchronous reserve for a user-initiated dispatch. MUST be called before
 * the first `await` on every dispatch path so a concurrent submit observes
 * the session as busy. Returns the new generation; pass it back to
 * `markTurnTerminal` when reporting a dispatch-scoped outcome.
 */
export function beginTurnDispatch(sessionId: string): number {
  const state = getState(sessionId);
  state.generation += 1;
  // Re-arm even if already dispatching: a new reserve restarts the bound.
  state.phase = "dispatching";
  armDeadman(sessionId, state, "dispatching", DISPATCHING_DEADMAN_MS);
  bumpSignal();
  return state.generation;
}

/**
 * Provider signalled that a turn is running. Opens a new turn when idle
 * (provider-initiated turns: restored running sessions, plan-approval build
 * turns, org-coordinator dispatches) and confirms a pending dispatch.
 * Never downgrades "stopping" — a late running ack must not cancel a Stop.
 */
export function markTurnRunning(
  sessionId: string,
  options: { generation?: number } = {}
): void {
  const state = getState(sessionId);
  if (
    options.generation !== undefined &&
    options.generation !== state.generation
  ) {
    return;
  }
  if (state.phase === "working" || state.phase === "stopping") return;
  if (state.phase === "idle") {
    state.generation += 1;
  }
  transition(sessionId, state, "working");
}

/**
 * Confirmation-only running ack: promotes "dispatching" to "working" but
 * never opens a turn from idle. Use for low-trust activity signals (raw
 * event traffic) that may trail a terminal.
 */
export function confirmTurnRunning(sessionId: string): void {
  const state = getState(sessionId);
  if (state.phase !== "dispatching") return;
  transition(sessionId, state, "working");
}

/**
 * User pressed Stop (or Send Now requested an interrupt). The turn stays
 * blocked for queueing purposes until the provider delivers the cancelled /
 * failed / completed terminal for it, bounded by the stopping dead-man.
 */
export function beginTurnStopping(sessionId: string): void {
  const state = getState(sessionId);
  if (state.phase === "idle") return;
  transition(sessionId, state, "stopping");
}

/**
 * Provider delivered a turn-final terminal. This is the ONLY natural way a
 * turn ends.
 *
 * - `generation` provided and stale → discarded (late terminal of old turn).
 * - No `generation` while "dispatching" → discarded (an unattributed
 *   terminal arriving before the running ack belongs to an older turn).
 */
export function markTurnTerminal(
  sessionId: string,
  status: TurnTerminalStatus,
  options: { generation?: number } = {}
): void {
  const state = getState(sessionId);
  if (
    options.generation !== undefined &&
    options.generation !== state.generation
  ) {
    return;
  }
  if (state.phase === "dispatching" && options.generation === undefined) {
    log.warn(
      `[turnLifecycle] discarding unattributed "${status}" terminal for ` +
        `session ${sessionId} while dispatching (generation ${state.generation})`
    );
    return;
  }
  state.lastTerminal = {
    generation: state.generation,
    status,
    at: Date.now(),
  };
  if (state.phase !== "idle") {
    transition(sessionId, state, "idle");
  } else {
    bumpSignal();
  }
}

/**
 * Explicit boundary override: rewind boundaries and bounded fallbacks force
 * the session idle without a provider terminal. The generation is bumped so
 * any in-flight terminal of the overridden turn is discarded when it lands.
 */
export function forceTurnIdle(sessionId: string): void {
  const state = getState(sessionId);
  state.generation += 1;
  if (state.phase !== "idle") {
    transition(sessionId, state, "idle");
  } else {
    clearDeadman(state);
    bumpSignal();
  }
}

export function getTurnPhase(sessionId: string): TurnPhase {
  return stateBySession.get(sessionId)?.phase ?? "idle";
}

export function isTurnActive(sessionId: string): boolean {
  return getTurnPhase(sessionId) !== "idle";
}

export function getTurnGeneration(sessionId: string): number {
  return stateBySession.get(sessionId)?.generation ?? 0;
}

export function getLastTurnTerminal(
  sessionId: string
): { generation: number; status: TurnTerminalStatus; at: number } | null {
  return stateBySession.get(sessionId)?.lastTerminal ?? null;
}

/** Release all retained lifecycle state when a session is permanently removed. */
export function clearTurnLifecycleSession(sessionId: string): void {
  const state = stateBySession.get(sessionId);
  if (!state) return;
  clearDeadman(state);
  stateBySession.delete(sessionId);
  bumpSignal();
}

export function resetTurnLifecycleForTests(): void {
  for (const state of stateBySession.values()) {
    clearDeadman(state);
  }
  stateBySession.clear();
}
