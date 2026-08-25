/**
 * Canonical frontend turn dispatch/finality boundary.
 *
 * Feature callers reserve synchronously before their first await, then send
 * through the shared transport path and optionally await the exact generation
 * terminal. UI-specific transcript writes stay outside this service.
 */
import {
  beginOptimisticTurn,
  clearRecentOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  publishTurnIntentDispatch,
  publishTurnIntentDispatchAlias,
  waitForTurnIntentDispatch,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  type TurnTerminalStatus,
  beginTurnDispatch,
  confirmTurnRunning,
  getTurnGeneration,
  getTurnTerminal,
  markTurnTerminal,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { createLogger } from "@src/hooks/logger";
import { markSessionActive } from "@src/store/session";
import {
  type SessionRuntimeStatusSource,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

import { SessionService } from "./SessionService";
import type { SessionSendMessageParams } from "./types";

export interface ReservedTurnDispatch {
  sessionId: string;
  turnIntentId: string;
  generation: number;
  optimisticSource: SessionRuntimeStatusSource;
}

export interface TurnDispatchAccepted extends ReservedTurnDispatch {
  accepted: true;
}

export interface TurnOutcome extends ReservedTurnDispatch {
  status: TurnTerminalStatus;
  at: number;
}

export interface ReserveTurnDispatchInput {
  sessionId: string;
  turnIntentId?: string;
  optimisticSource?: SessionRuntimeStatusSource;
}

export type SendReservedTurnInput = Omit<
  SessionSendMessageParams,
  "sessionId" | "turnIntentId"
> & {
  dispatch: ReservedTurnDispatch;
};

export type DispatchTurnInput = Omit<SendReservedTurnInput, "dispatch"> &
  ReserveTurnDispatchInput;

interface DurableReceiptReconcileOptions {
  acknowledgedStatus?: string | null;
  acknowledgedEffectiveTurnIntentId?: string | null;
  forceAuthoritativeRead?: boolean;
  monitorNonterminalUntilFinality?: boolean;
}

interface EffectiveTurnStatusMonitor {
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  backoffIndex: number;
  effectiveTurnIntentId: string;
  preserveRuntimePresentationOnTerminal: boolean;
}

const log = createLogger("TurnDispatchService");
const EFFECTIVE_STATUS_BACKOFF_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000,
] as const;
const effectiveTurnStatusMonitors = new Map<
  string,
  EffectiveTurnStatusMonitor
>();

function effectiveMonitorKey(dispatch: ReservedTurnDispatch): string {
  return JSON.stringify([dispatch.sessionId, dispatch.generation]);
}

function stopEffectiveTurnStatusMonitor(dispatch: ReservedTurnDispatch): void {
  const key = effectiveMonitorKey(dispatch);
  const monitor = effectiveTurnStatusMonitors.get(key);
  if (!monitor) return;
  if (monitor.timer !== null) clearTimeout(monitor.timer);
  monitor.unsubscribe?.();
  effectiveTurnStatusMonitors.delete(key);
}

export function resetTurnDispatchMonitorsForTests(): void {
  for (const monitor of effectiveTurnStatusMonitors.values()) {
    if (monitor.timer !== null) clearTimeout(monitor.timer);
    monitor.unsubscribe?.();
  }
  effectiveTurnStatusMonitors.clear();
}

function failAttribution(
  dispatch: ReservedTurnDispatch,
  message: string
): never {
  failReservedTurn(dispatch);
  throw new Error(message);
}

function bindEffectiveTurnIntent(
  dispatch: ReservedTurnDispatch,
  effectiveTurnIntentId: string | null | undefined
): string {
  const effective = effectiveTurnIntentId ?? dispatch.turnIntentId;
  if (!effective) {
    return failAttribution(
      dispatch,
      `empty effective turn intent for ${dispatch.turnIntentId}`
    );
  }
  if (
    effective !== dispatch.turnIntentId &&
    !publishTurnIntentDispatchAlias(effective, {
      sessionId: dispatch.sessionId,
      generation: dispatch.generation,
    })
  ) {
    return failAttribution(
      dispatch,
      `effective turn intent ${effective} conflicts with ${dispatch.turnIntentId}`
    );
  }
  return effective;
}

function settleDurableTerminalReceipt(
  dispatch: ReservedTurnDispatch,
  receiptStatus: "completed" | "failed" | "cancelled" | "coalesced",
  options: { preserveRuntimePresentation?: boolean } = {}
): TurnDispatchAccepted {
  stopEffectiveTurnStatusMonitor(dispatch);
  // A delayed receipt for an older reservation is still a successful
  // transport reconciliation. Its exact terminal/mapping must close, but it
  // must not clear or overwrite the optimistic mirror owned by a newer
  // generation.
  const ownsCurrentGeneration =
    getTurnGeneration(dispatch.sessionId) === dispatch.generation;
  const terminalStatus =
    receiptStatus === "coalesced" ? "failed" : receiptStatus;
  // Always clear the dispatch-only optimistic marker. Exact-X ambiguity may
  // be a consumed steering augmentation while its underlying provider turn
  // is still running, so that monitor settles lifecycle finality without
  // overwriting the provider-owned runtime presentation. Project Y owns a
  // standalone run and continues to project its durable terminal here.
  if (ownsCurrentGeneration) {
    clearRecentOptimisticTurn(dispatch.sessionId);
    if (!options.preserveRuntimePresentation) {
      getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
        sessionId: dispatch.sessionId,
        status: terminalStatus,
        source: dispatch.optimisticSource,
      });
    }
  }
  markTurnTerminal(dispatch.sessionId, terminalStatus, {
    generation: dispatch.generation,
  });
  markSessionActive(dispatch.sessionId);
  return { ...dispatch, accepted: true };
}

function startEffectiveTurnStatusMonitor(
  dispatch: ReservedTurnDispatch,
  effectiveTurnIntentId: string,
  options: { preserveRuntimePresentationOnTerminal?: boolean } = {}
): void {
  if (
    getTurnGeneration(dispatch.sessionId) !== dispatch.generation ||
    getTurnTerminal(dispatch.sessionId, dispatch.generation)
  ) {
    return;
  }
  const key = effectiveMonitorKey(dispatch);
  if (effectiveTurnStatusMonitors.has(key)) return;
  const monitor: EffectiveTurnStatusMonitor = {
    timer: null,
    unsubscribe: null,
    backoffIndex: 0,
    effectiveTurnIntentId,
    preserveRuntimePresentationOnTerminal:
      options.preserveRuntimePresentationOnTerminal ?? false,
  };
  effectiveTurnStatusMonitors.set(key, monitor);

  const stop = (): void => {
    if (effectiveTurnStatusMonitors.get(key) !== monitor) return;
    if (monitor.timer !== null) clearTimeout(monitor.timer);
    monitor.unsubscribe?.();
    monitor.timer = null;
    monitor.unsubscribe = null;
    effectiveTurnStatusMonitors.delete(key);
  };
  const scheduleNext = (): void => {
    if (effectiveTurnStatusMonitors.get(key) !== monitor) return;
    if (
      getTurnGeneration(dispatch.sessionId) !== dispatch.generation ||
      getTurnTerminal(dispatch.sessionId, dispatch.generation)
    ) {
      stop();
      return;
    }
    const backoffMs =
      EFFECTIVE_STATUS_BACKOFF_MS[
        Math.min(monitor.backoffIndex, EFFECTIVE_STATUS_BACKOFF_MS.length - 1)
      ];
    monitor.backoffIndex += 1;
    monitor.timer = setTimeout(() => {
      monitor.timer = null;
      void poll();
    }, backoffMs);
  };
  const poll = async (): Promise<void> => {
    if (effectiveTurnStatusMonitors.get(key) !== monitor) return;
    if (
      getTurnGeneration(dispatch.sessionId) !== dispatch.generation ||
      getTurnTerminal(dispatch.sessionId, dispatch.generation)
    ) {
      stop();
      return;
    }

    let durableReceipt: Awaited<
      ReturnType<typeof SessionService.getTurnIntentStatus>
    >;
    try {
      durableReceipt = await SessionService.getTurnIntentStatus(
        dispatch.sessionId,
        dispatch.turnIntentId
      );
    } catch {
      scheduleNext();
      return;
    }
    if (effectiveTurnStatusMonitors.get(key) !== monitor) return;
    if (!durableReceipt) {
      scheduleNext();
      return;
    }

    try {
      const observedEffectiveTurnIntentId = bindEffectiveTurnIntent(
        dispatch,
        durableReceipt.effectiveTurnIntentId
      );
      if (observedEffectiveTurnIntentId !== monitor.effectiveTurnIntentId) {
        failAttribution(
          dispatch,
          `durable effective turn intent ${observedEffectiveTurnIntentId} ` +
            `conflicts with monitor ${monitor.effectiveTurnIntentId}`
        );
      }
      switch (durableReceipt.status) {
        case "queued":
          scheduleNext();
          return;
        case "running":
          confirmTurnRunning(dispatch.sessionId, {
            generation: dispatch.generation,
          });
          markSessionActive(dispatch.sessionId);
          scheduleNext();
          return;
        case "completed":
        case "failed":
        case "cancelled":
        case "coalesced":
          settleDurableTerminalReceipt(dispatch, durableReceipt.status, {
            preserveRuntimePresentation:
              monitor.preserveRuntimePresentationOnTerminal,
          });
          return;
        case "optimistic":
        case "stale":
        case "rejected":
        default:
          failReservedTurn(dispatch);
          stop();
          return;
      }
    } catch (error) {
      stop();
      log.warn(
        `[TurnDispatchService] effective turn status monitor stopped: ${String(error)}`
      );
    }
  };

  // Live exact terminals and generation supersession are the primary stop
  // signal. The recursive status read is only a low-frequency safety net for
  // a dropped terminal event or a pre-runtime dead-letter.
  monitor.unsubscribe = getInstrumentedStore().sub(
    turnLifecycleSignalAtom,
    () => {
      if (
        getTurnGeneration(dispatch.sessionId) !== dispatch.generation ||
        getTurnTerminal(dispatch.sessionId, dispatch.generation)
      ) {
        stop();
      }
    }
  );
  scheduleNext();
}

async function reconcileDurableTurnIntentReceipt(
  dispatch: ReservedTurnDispatch,
  transportError: unknown,
  options: DurableReceiptReconcileOptions = {}
): Promise<TurnDispatchAccepted> {
  const hasAcknowledgedEffectiveTurnIntent =
    options.acknowledgedEffectiveTurnIntentId != null;
  let effectiveTurnIntentId = bindEffectiveTurnIntent(
    dispatch,
    options.acknowledgedEffectiveTurnIntentId
  );
  let receiptStatus = options.acknowledgedStatus;
  if (options.forceAuthoritativeRead || receiptStatus == null) {
    const durableReceipt = await SessionService.getTurnIntentStatus(
      dispatch.sessionId,
      dispatch.turnIntentId
    ).catch(() => null);
    if (durableReceipt) {
      const durableEffectiveTurnIntentId = bindEffectiveTurnIntent(
        dispatch,
        durableReceipt.effectiveTurnIntentId
      );
      if (
        hasAcknowledgedEffectiveTurnIntent &&
        durableEffectiveTurnIntentId !== effectiveTurnIntentId
      ) {
        return failAttribution(
          dispatch,
          `durable effective turn intent ${durableEffectiveTurnIntentId} ` +
            `conflicts with acknowledgement ${effectiveTurnIntentId}`
        );
      }
      effectiveTurnIntentId = durableEffectiveTurnIntentId;
      receiptStatus = durableReceipt.status;
    } else {
      receiptStatus = null;
    }
  }

  // Keep this switch explicit and fail closed. A new backend status must not
  // silently become an unbounded frontend `working` phase.
  const shouldMonitorNonterminal =
    effectiveTurnIntentId !== dispatch.turnIntentId ||
    options.monitorNonterminalUntilFinality === true;
  const preserveRuntimePresentationOnTerminal =
    effectiveTurnIntentId === dispatch.turnIntentId &&
    options.monitorNonterminalUntilFinality === true;
  switch (receiptStatus) {
    case "queued":
      if (shouldMonitorNonterminal) {
        // X→Y is a durable backend ownership transfer. A legitimate Y can
        // remain queued behind another turn/setup/path lock for longer than
        // any sound frontend elapsed-time bound, so clear the pre-accept
        // dead-man and reconcile durable finality until terminal or exact-
        // generation supersession. Exact-X response-loss/duplicate receipts
        // also need this path because a consumed steering intent has no
        // standalone provider terminal.
        confirmTurnRunning(dispatch.sessionId, {
          generation: dispatch.generation,
        });
        startEffectiveTurnStatusMonitor(dispatch, effectiveTurnIntentId, {
          preserveRuntimePresentationOnTerminal,
        });
        markSessionActive(dispatch.sessionId);
        return { ...dispatch, accepted: true };
      }
      confirmTurnRunning(dispatch.sessionId, {
        generation: dispatch.generation,
      });
      markSessionActive(dispatch.sessionId);
      return { ...dispatch, accepted: true };
    case "running":
      confirmTurnRunning(dispatch.sessionId, {
        generation: dispatch.generation,
      });
      if (shouldMonitorNonterminal) {
        startEffectiveTurnStatusMonitor(dispatch, effectiveTurnIntentId, {
          preserveRuntimePresentationOnTerminal,
        });
      }
      markSessionActive(dispatch.sessionId);
      return { ...dispatch, accepted: true };
    case "completed":
    case "failed":
    case "cancelled":
    case "coalesced":
      return settleDurableTerminalReceipt(dispatch, receiptStatus);
    case "optimistic":
    case "stale":
    case "rejected":
    case null:
    default:
      failReservedTurn(dispatch);
      throw transportError;
  }
}

/** Reserve the session generation and intent synchronously before any await. */
export function reserveTurnDispatch(
  input: ReserveTurnDispatchInput
): ReservedTurnDispatch {
  const turnIntentId = input.turnIntentId ?? mintTurnIntentId();
  const generation = beginTurnDispatch(input.sessionId);
  publishTurnIntentDispatch(turnIntentId, {
    sessionId: input.sessionId,
    generation,
  });
  const optimisticSource = input.optimisticSource ?? "dispatch";
  beginOptimisticTurn(input.sessionId, optimisticSource);
  return {
    sessionId: input.sessionId,
    turnIntentId,
    generation,
    optimisticSource,
  };
}

/** Close a reservation that failed before transport dispatch began. */
export function failReservedTurn(dispatch: ReservedTurnDispatch): void {
  stopEffectiveTurnStatusMonitor(dispatch);
  // A response from an older reservation may arrive after another submit has
  // installed a new optimistic mirror. Roll back presentation only for the
  // current generation, but always finalize the exact failed reservation so
  // its waiter and intent mapping cannot leak.
  if (getTurnGeneration(dispatch.sessionId) === dispatch.generation) {
    failOptimisticTurn(dispatch.sessionId, dispatch.optimisticSource);
  }
  if (getTurnTerminal(dispatch.sessionId, dispatch.generation)) return;
  markTurnTerminal(dispatch.sessionId, "failed", {
    generation: dispatch.generation,
  });
}

/** Send an already-reserved turn through the category adapter. */
export async function sendReservedTurn(
  input: SendReservedTurnInput
): Promise<TurnDispatchAccepted> {
  const { dispatch, ...params } = input;
  let receipt: Awaited<ReturnType<typeof SessionService.sendMessage>>;
  try {
    receipt = await SessionService.sendMessage({
      ...params,
      sessionId: dispatch.sessionId,
      turnIntentId: dispatch.turnIntentId,
      // The logical intent is also the default transport idempotency key.
      // Callers may provide a stable domain-specific key, but no canonical
      // dispatch is allowed to fall back to an un-deduplicated send.
      clientMessageId: params.clientMessageId ?? dispatch.turnIntentId,
    });
  } catch (error) {
    // Tauri can lose a successful command response after the backend has
    // already persisted/enqueued the exact intent. Read the durable receipt
    // before declaring rejection; this keeps response loss from becoming a
    // second logical turn on retry.
    return reconcileDurableTurnIntentReceipt(dispatch, error, {
      forceAuthoritativeRead: true,
      monitorNonterminalUntilFinality: true,
    });
  }

  const effectiveTurnIntentId = bindEffectiveTurnIntent(
    dispatch,
    receipt.effectiveTurnIntentId
  );
  if (effectiveTurnIntentId !== dispatch.turnIntentId) {
    // The effective WorkItemRun may have reached terminal before the enqueue
    // acknowledgement crossed IPC and before this window could install Y as
    // an alias for composer intent X. Re-read X after alias publication so
    // durable finality closes the original reserved generation even when the
    // live Y terminal was presentation-only in this window.
    return reconcileDurableTurnIntentReceipt(
      dispatch,
      new Error(
        `effective turn ${effectiveTurnIntentId} has no executable durable receipt`
      ),
      {
        acknowledgedStatus: receipt.turnIntentStatus,
        acknowledgedEffectiveTurnIntentId: effectiveTurnIntentId,
        forceAuthoritativeRead: true,
      }
    );
  }

  if (receipt.duplicate) {
    return reconcileDurableTurnIntentReceipt(
      dispatch,
      new Error(
        `duplicate send for ${dispatch.turnIntentId} has no executable durable receipt`
      ),
      {
        acknowledgedStatus: receipt.turnIntentStatus,
        acknowledgedEffectiveTurnIntentId: effectiveTurnIntentId,
        monitorNonterminalUntilFinality: true,
      }
    );
  }

  if (receipt.steered) {
    // Mid-turn steering is an accepted augmentation of a provider turn, not
    // a standalone turn that will emit its own provider terminal. Settle this
    // reservation exactly while leaving the authoritative runtime-status
    // presentation untouched (the underlying turn is still running).
    if (getTurnGeneration(dispatch.sessionId) === dispatch.generation) {
      clearRecentOptimisticTurn(dispatch.sessionId);
    }
    markTurnTerminal(dispatch.sessionId, "completed", {
      generation: dispatch.generation,
    });
    markSessionActive(dispatch.sessionId);
    return { ...dispatch, accepted: true };
  }

  confirmTurnRunning(dispatch.sessionId, { generation: dispatch.generation });
  markSessionActive(dispatch.sessionId);
  if (isCliSession(dispatch.sessionId)) {
    // CLI live status normally arrives over the window-level WebSocket, but
    // hidden/background runners and isolated app instances may not have that
    // channel. Reuse the canonical exact-intent durable monitor so provider
    // finality never depends on a mounted transcript or an active socket.
    startEffectiveTurnStatusMonitor(dispatch, effectiveTurnIntentId);
  }
  if (isCursorIdeSession(dispatch.sessionId)) {
    if (getTurnGeneration(dispatch.sessionId) !== dispatch.generation) {
      return { ...dispatch, accepted: true };
    }
    getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
      sessionId: dispatch.sessionId,
      status: "idle",
      source: dispatch.optimisticSource,
    });
    markTurnTerminal(dispatch.sessionId, "completed", {
      generation: dispatch.generation,
    });
  }
  return { ...dispatch, accepted: true };
}

/** Convenience for headless callers that do not need a pre-send UI write. */
export async function dispatchTurn(
  input: DispatchTurnInput
): Promise<TurnDispatchAccepted> {
  const { sessionId, turnIntentId, optimisticSource, ...sendParams } = input;
  const dispatch = reserveTurnDispatch({
    sessionId,
    turnIntentId,
    optimisticSource,
  });
  return sendReservedTurn({ dispatch, ...sendParams });
}

/** Wait for the provider terminal belonging to this exact reservation. */
export function waitForTurnOutcome(
  dispatch: ReservedTurnDispatch,
  deadlineMs: number
): Promise<TurnOutcome> {
  const readOutcome = (): TurnOutcome | null => {
    const terminal = getTurnTerminal(dispatch.sessionId, dispatch.generation);
    if (!terminal) return null;
    return { ...dispatch, status: terminal.status, at: terminal.at };
  };
  const immediate = readOutcome();
  if (immediate) return Promise.resolve(immediate);

  return new Promise<TurnOutcome>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("turn outcome timed out"));
      return;
    }
    const store = getInstrumentedStore();
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("turn outcome timed out"));
    }, remainingMs);
    const check = (): void => {
      const outcome = readOutcome();
      if (!outcome) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(outcome);
    };
    unsubscribe = store.sub(turnLifecycleSignalAtom, check);
    check();
  });
}

/**
 * Resolve a caller-owned intent to its exact reserved generation, then await
 * that generation's terminal. Queued and direct turns share this rendezvous;
 * feature modules must not reimplement terminal subscriptions or timestamps.
 */
export async function waitForTurnIntentOutcome(
  turnIntentId: string,
  deadlineMs: number
): Promise<TurnOutcome> {
  const dispatch = await waitForTurnIntentDispatch(turnIntentId, deadlineMs);
  return waitForTurnOutcome(
    {
      ...dispatch,
      turnIntentId,
      // This field is relevant only to pre-transport rollback. The intent has
      // already dispatched by the time this observer resolves it.
      optimisticSource: "dispatch",
    },
    deadlineMs
  );
}
