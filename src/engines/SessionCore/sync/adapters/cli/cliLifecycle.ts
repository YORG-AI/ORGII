import {
  type TurnTerminalStatus,
  markTurnRunning,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { isTurnBlockingRuntimeEvent } from "@src/engines/SessionCore/core/runningEventGate";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { setSessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import type { CliSessionStatus } from "@src/types/session/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

const log = createLogger("CliAdapter");

// Keep the renderer terminal mirror within the dual-instance completion SLO.
// The underlying persistence promise is deliberately not cancelled: if a
// delayed EventStore RPC eventually settles, the adapter's existing
// reconcileTerminalEventsIfNeeded callback closes the late row.
const CLI_TERMINAL_PERSISTENCE_DEADLINE_MS = 4_000;

/**
 * EventStore writes started by the session-scoped CLI adapter. Native
 * transcript reconciliation can be woken by the backend terminal intent
 * before those async writes settle, so both paths join this one barrier.
 */
const pendingCliEventPersistence = new Map<string, Set<Promise<unknown>>>();

export function trackCliEventPersistence(
  sessionId: string,
  operation: Promise<unknown>
): void {
  const pending = pendingCliEventPersistence.get(sessionId) ?? new Set();
  pendingCliEventPersistence.set(sessionId, pending);
  pending.add(operation);
  const release = () => {
    pending.delete(operation);
    if (pending.size === 0) pendingCliEventPersistence.delete(sessionId);
  };
  operation.then(release, release);
}

export async function waitForCliEventPersistence(
  sessionId: string
): Promise<void> {
  // A settling normalization can enqueue its EventStore write in the same
  // microtask. Re-read the set until the session has no observed work left.
  for (;;) {
    const pending = pendingCliEventPersistence.get(sessionId);
    if (!pending || pending.size === 0) return;
    await Promise.allSettled([...pending]);
  }
}

const CLI_TERMINAL_STATUSES = new Set<CliSessionStatus>([
  "completed",
  "failed",
  "error",
  "cancelled",
  "abandoned",
  "timeout",
  "archived",
]);

export function isCliTerminalStatus(
  status: string | undefined
): status is CliSessionStatus {
  return (
    status !== undefined &&
    CLI_TERMINAL_STATUSES.has(status as CliSessionStatus)
  );
}

/**
 * True when a terminal CLI row may own provider-portable EventStore output
 * that never reached the provider transcript. Keep this derived from the
 * central terminal classification so continuation cannot drift into a second
 * raw-status allowlist.
 */
export function isInterruptedCliTerminalStatus(
  status: string | undefined
): boolean {
  if (!status || !CLI_TERMINAL_STATUSES.has(status as CliSessionStatus)) {
    return false;
  }
  return cliTerminalStatus(status as CliSessionStatus) !== "completed";
}

function durableInterruptedToolOutput(event: SessionEvent): string | null {
  for (const candidate of [event.result?.output, event.result?.observation]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

export async function closeObservedCliTerminalEvents(
  sessionId: string,
  status: CliSessionStatus
): Promise<void> {
  await waitForCliEventPersistence(sessionId);
  // Interrupted native Sessions can be hidden, cold-started, or evicted from
  // the in-memory turn window. Their portable suffix is durable EventStore
  // state, so close against full persisted history. Completed turns stay on
  // the cheap resident path because their provider transcript is authoritative.
  const events = isInterruptedCliTerminalStatus(status)
    ? await eventStoreProxy.getPersistedEvents(sessionId)
    : await eventStoreProxy.getEvents(sessionId);
  const closableEvents = events.filter((event) => {
    if (event.sessionId && event.sessionId !== sessionId) return false;
    return isTurnBlockingRuntimeEvent(event);
  });
  if (closableEvents.length === 0) return;
  const displayStatus =
    status === "failed" || status === "error" ? "failed" : "completed";
  await Promise.all(
    closableEvents.map((event) => {
      const unresolvedToolCall =
        event.actionType === "tool_call" ||
        Boolean(event.callId && event.functionName);
      const interruptedToolHasOutput =
        unresolvedToolCall && durableInterruptedToolOutput(event) !== null;
      return eventStoreProxy.upsert(
        {
          ...event,
          displayStatus,
          activityStatus: "processed",
          // A visible assistant stream is useful partial conversation text,
          // so terminalize it into a portable message. A running tool call is
          // different: no provider may receive it without a paired result.
          // Keep it in ORG2 as interrupted diagnostics, but leave a pending
          // result fence when it has no output, so native projection drops it
          // until a real result arrives and replaces this row. Output already
          // observed before Stop is durable conversation state: close that
          // pair as an interrupted result so another runtime receives it as a
          // provider-native error result instead of silently losing stdout.
          result: unresolvedToolCall
            ? {
                ...event.result,
                status: interruptedToolHasOutput ? "interrupted" : "pending",
                interrupted: true,
              }
            : { ...event.result, status: displayStatus },
          isDelta: false,
        },
        sessionId
      );
    })
  );
}

export function markCliRuntimeRunning(
  sessionId: string,
  generation?: number
): boolean {
  if (!markTurnRunning(sessionId, { generation })) return false;
  if (!isStoreInitialized()) return true;
  getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
    sessionId,
    status: "running",
    source: "sync",
  });
  return true;
}

export async function markObservedCliTerminalStatus(
  sessionId: string,
  status: CliSessionStatus | undefined
): Promise<void> {
  if (!isCliTerminalStatus(status) || !isStoreInitialized()) {
    return;
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const terminalPersistence = closeObservedCliTerminalEvents(
    sessionId,
    status
  ).then(
    () => "settled" as const,
    (error) => {
      log.warn("[cliAdapter] failed to close terminal CLI events:", error);
      return "settled" as const;
    }
  );
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve("deadline"),
      CLI_TERMINAL_PERSISTENCE_DEADLINE_MS
    );
  });
  const persistenceResult = await Promise.race([terminalPersistence, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (persistenceResult === "deadline") {
    log.warn(
      `[cliAdapter] terminal EventStore reconciliation exceeded ${CLI_TERMINAL_PERSISTENCE_DEADLINE_MS}ms; publishing terminal state while late writes keep reconciling`,
      { sessionId, status }
    );
  }
  // Runtime/model switching is exposed by this terminal mirror. Publish it
  // only after every visible partial row crossed the EventStore barrier.
  getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
    sessionId,
    status,
    source: "sync",
  });
}

export function cliTerminalStatus(
  status: CliSessionStatus
): TurnTerminalStatus {
  if (status === "failed" || status === "error" || status === "timeout") {
    return "failed";
  }
  if (status === "cancelled" || status === "abandoned") return "cancelled";
  return "completed";
}
