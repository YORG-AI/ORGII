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
 *   - A terminal carrying an older exact generation is retained for that
 *     generation's observers, but can never release the queue or mutate the
 *     phase of a newer turn.
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

import {
  retireSessionTurnIntentDispatches,
  retireTurnIntentDispatch,
} from "./turnIntentDispatchLifecycle";

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
  /**
   * Exact terminals retained by generation. A single `lastTerminal` slot is
   * insufficient when a later turn finishes before an observer of the prior
   * generation attaches (or while that observer is still scheduled).
   */
  terminalsByGeneration: Map<
    number,
    { generation: number; status: TurnTerminalStatus; at: number }
  >;
  deadmanTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_RETAINED_TERMINALS_PER_SESSION = 32;

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
      terminalsByGeneration: new Map(),
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
    forceTurnIdleFromDeadman(
      sessionId,
      current,
      phase === "stopping" ? "cancelled" : "failed"
    );
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

function recordTurnTerminal(
  sessionId: string,
  state: SessionTurnState,
  generation: number,
  status: TurnTerminalStatus
): boolean {
  // Terminal finality is monotonic for one exact generation. In particular,
  // an IPC response-loss catch must not overwrite a completed provider
  // terminal with a synthetic failed terminal for the same dispatch.
  if (state.terminalsByGeneration.has(generation)) return false;
  retireTurnIntentDispatch(sessionId, generation);
  const terminal = {
    generation,
    status,
    at: Date.now(),
  };
  // `lastTerminal` is a generation watermark used by follow-up observers.
  // A delayed exact terminal for an older turn must remain queryable by its
  // generation without moving that watermark backwards.
  if (!state.lastTerminal || generation >= state.lastTerminal.generation) {
    state.lastTerminal = terminal;
  }
  state.terminalsByGeneration.set(generation, terminal);
  while (
    state.terminalsByGeneration.size > MAX_RETAINED_TERMINALS_PER_SESSION
  ) {
    const oldestGeneration = state.terminalsByGeneration.keys().next().value as
      | number
      | undefined;
    if (oldestGeneration === undefined) break;
    state.terminalsByGeneration.delete(oldestGeneration);
  }
  return true;
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
  if (
    options.generation !== undefined &&
    state.terminalsByGeneration.has(options.generation)
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
export function confirmTurnRunning(
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
 * - `generation` provided and stale → recorded for that exact generation,
 *   but never allowed to change the newer generation's phase.
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
    options.generation > state.generation
  ) {
    log.warn(
      `[turnLifecycle] discarding future-generation "${status}" terminal for ` +
        `session ${sessionId} (signal ${options.generation}, current ${state.generation})`
    );
    return;
  }
  if (state.phase === "dispatching" && options.generation === undefined) {
    log.warn(
      `[turnLifecycle] discarding unattributed "${status}" terminal for ` +
        `session ${sessionId} while dispatching (generation ${state.generation})`
    );
    return;
  }
  const generation = options.generation ?? state.generation;
  if (!recordTurnTerminal(sessionId, state, generation, status)) return;
  if (generation !== state.generation) {
    // Exact finality belongs to an older reservation. Wake exact-generation
    // observers and retire its identities, but preserve every bit of the
    // newer turn's phase/timer state.
    bumpSignal();
    return;
  }
  if (state.phase !== "idle") {
    transition(sessionId, state, "idle");
  } else {
    bumpSignal();
  }
}

function forceTurnIdleFromDeadman(
  sessionId: string,
  state: SessionTurnState,
  displacedStatus: TurnTerminalStatus
): void {
  const displacedGeneration = state.generation;
  recordTurnTerminal(sessionId, state, displacedGeneration, displacedStatus);
  // Advance the fence after recording the displaced generation so a delayed
  // provider signal cannot become the terminal of whatever starts next.
  state.generation += 1;
  if (state.phase !== "idle") {
    transition(sessionId, state, "idle");
  } else {
    clearDeadman(state);
    bumpSignal();
  }
}

/**
 * Explicit boundary override: rewind boundaries and bounded fallbacks force
 * the session idle without a provider terminal. The generation is bumped so
 * any in-flight terminal of the overridden turn cannot mutate the new phase
 * when it lands (its exact finality is still retained by generation).
 */
export function forceTurnIdle(sessionId: string): void {
  const state = getState(sessionId);
  retireTurnIntentDispatch(sessionId, state.generation);
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

/** Read the immutable terminal for one exact reserved generation. */
export function getTurnTerminal(
  sessionId: string,
  generation: number
): { generation: number; status: TurnTerminalStatus; at: number } | null {
  return (
    stateBySession.get(sessionId)?.terminalsByGeneration.get(generation) ?? null
  );
}

/** Release all retained lifecycle state when a session is permanently removed. */
export function clearTurnLifecycleSession(sessionId: string): void {
  // Intent aliases can be published before any lifecycle state is observed
  // (for example, a recovered receipt during cold startup). Always clear
  // those identities even when this process has no SessionTurnState yet.
  retireSessionTurnIntentDispatches(sessionId);
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
