/**
 * One non-React direct user-intent dispatch boundary.
 *
 * UI hooks still decide whether a prompt queues, how duplicate clicks are
 * suppressed, and which runtime/model/account to use. Once a concrete Session
 * is ready, every direct path comes through this module so the synthetic user
 * row, turn generation, optimistic footer, backend acceptance, and rollback
 * cannot drift between ordinary sends and conversation continuations.
 */
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { publishTurnIntentDispatch } from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  type TurnTerminalStatus,
  beginTurnDispatch,
  confirmTurnRunning,
  markTurnTerminal,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { deliverOptimisticOutgoing } from "@src/engines/SessionCore/services/optimisticOutgoingDelivery";
import type { SessionSendMessageParams } from "@src/engines/SessionCore/services/types";
import { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { createLogger } from "@src/hooks/logger";
import { markSessionActive } from "@src/store/session";
import {
  type SessionRuntimeStatusSource,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

const log = createLogger("UserIntentDispatch");
const OPTIMISTIC_QUEUE_USER_EVENT_ID_PREFIX = "queued-user:";

export interface UserIntentPreparation {
  sessionId: string;
  userEvent: SessionEvent;
  generation: number;
  turnIntentId: string;
  runtimeStatusSource: SessionRuntimeStatusSource;
}

/**
 * Lifecycle handle for a provider turn that was already accepted before this
 * renderer attached to it. Unlike UserIntentPreparation it owns no synthetic
 * user row: the durable provider/canonical transcript already owns that row.
 */
export interface AdoptedUserIntent {
  sessionId: string;
  generation: number;
  turnIntentId: string;
  runtimeStatusSource: SessionRuntimeStatusSource;
}

interface PrepareUserIntentParams {
  sessionId: string;
  visibleText: string;
  imageDataUrls?: string[];
  turnIntentId: string;
  runtimeStatusSource?: SessionRuntimeStatusSource;
  /** Preserve the durable queue identity on a newly created optimistic row. */
  queueMessageId?: string;
  /** Runs after the synchronous lifecycle reserve and before EventStore I/O. */
  beforeAppend?: () => void | Promise<void>;
}

export interface OptimisticUserDeliveryProjectionParams {
  sessionId: string;
  visibleText: string;
  imageDataUrls?: string[];
  turnIntentId: string;
  queueMessageId: string;
  createdAt?: string;
}

type UserIntentSendParams = Omit<
  SessionSendMessageParams,
  "sessionId" | "imageDataUrls" | "turnIntentId"
> & {
  turnIntentId: string;
};

export interface DispatchUserIntentParams extends Omit<
  PrepareUserIntentParams,
  "turnIntentId"
> {
  preparation?: UserIntentPreparation;
  send: UserIntentSendParams;
}

export interface DispatchUserIntentResult {
  preparation: UserIntentPreparation;
  userEvent: SessionEvent;
}

/**
 * A dispatch attempt failed after the optimistic row was durably appended.
 * Queue callers use this boundary to transfer retry ownership from the queue
 * card to the visible failed transcript row. Preparation/storage failures do
 * not use this error because the queue row is still the only durable copy.
 */
export class UserIntentSendError extends Error {
  readonly cause: unknown;
  readonly userEventId: string;

  constructor(error: unknown, userEventId: string) {
    super(
      error instanceof Error
        ? error.message
        : error == null
          ? "Failed to send message"
          : String(error)
    );
    this.name = "UserIntentSendError";
    this.cause = error;
    this.userEventId = userEventId;
  }
}

export function isUserIntentSendError(
  error: unknown
): error is UserIntentSendError {
  return error instanceof UserIntentSendError;
}

type UserIntentPreparationState = "prepared" | "accepted" | "failed";
const preparationStates = new WeakMap<
  UserIntentPreparation,
  UserIntentPreparationState
>();

function deliveryEvent(
  event: SessionEvent,
  status: "pending" | "sent" | "failed",
  error?: unknown
): SessionEvent {
  const reason =
    status === "failed"
      ? error instanceof Error
        ? error.message
        : error == null
          ? "Failed to send message"
          : String(error)
      : undefined;
  return {
    ...event,
    displayStatus:
      status === "pending"
        ? "pending"
        : status === "failed"
          ? "failed"
          : "completed",
    result: {
      ...event.result,
      deliveryStatus: status,
      ...(reason ? { deliveryError: reason } : {}),
    },
  };
}

/**
 * Stable EventStore identity for the queue-owned optimistic transcript row.
 *
 * The queue id, rather than message text or turn id, distinguishes a retry
 * from the failed row it supersedes. The turn id still reconciles this row
 * with the provider/native echo once that authoritative event arrives.
 */
export function optimisticQueueUserEventId(queueMessageId: string): string {
  // The terminal delimiter makes removeByIdPrefix an exact lookup for this
  // queue row: another queue id cannot extend this complete prefix.
  return `${OPTIMISTIC_QUEUE_USER_EVENT_ID_PREFIX}${queueMessageId}:`;
}

/** Whether an EventStore row is owned by the canonical queue projection. */
export function isOptimisticQueueUserEventId(eventId: string): boolean {
  return (
    eventId.startsWith(OPTIMISTIC_QUEUE_USER_EVENT_ID_PREFIX) &&
    eventId.endsWith(":")
  );
}

function optimisticQueueUserEvent(
  params: OptimisticUserDeliveryProjectionParams,
  status: "pending" | "sent" | "failed",
  error?: unknown
): SessionEvent {
  const reason =
    status === "failed"
      ? error instanceof Error
        ? error.message
        : error == null
          ? "Failed to send message"
          : String(error)
      : undefined;
  return createSyntheticUserEvent(params.sessionId, params.visibleText, {
    id: optimisticQueueUserEventId(params.queueMessageId),
    createdAt: params.createdAt,
    imageDataUrls: params.imageDataUrls,
    turnIntentId: params.turnIntentId,
    deliveryStatus: status,
    deliveryError: reason,
    queueMessageId: params.queueMessageId,
  });
}

/**
 * Persist the canonical queue's visible user row before handing the turn to
 * any provider/materializer. This is an EventStore projection only; the
 * existing durable message queue remains the sole dispatch authority.
 */
export async function appendOptimisticQueueUserDelivery(
  params: OptimisticUserDeliveryProjectionParams
): Promise<SessionEvent> {
  const event = optimisticQueueUserEvent(params, "pending");
  await eventStoreProxy.append([event], params.sessionId);
  return event;
}

/** Patch the exact queue-owned EventStore row in place. */
export async function setOptimisticQueueUserDelivery(
  params: OptimisticUserDeliveryProjectionParams,
  status: "pending" | "sent" | "failed",
  error?: unknown
): Promise<boolean> {
  const event = optimisticQueueUserEvent(params, status, error);
  return eventStoreProxy.updateById(
    event.id,
    {
      // Retry/edit-resend keeps the stable queue-owned row id. Patch the
      // complete user-facing payload as well as its delivery state so the same
      // bubble can move failed -> pending -> sent without an append/remove
      // cycle or stale text/attachments.
      displayText: event.displayText,
      displayStatus: event.displayStatus,
      result: event.result,
    },
    params.sessionId
  );
}

/** Remove only an admission attempt that never entered the durable queue. */
export async function removeOptimisticQueueUserDelivery(
  params: Pick<
    OptimisticUserDeliveryProjectionParams,
    "sessionId" | "queueMessageId"
  >
): Promise<void> {
  await eventStoreProxy.removeByIdPrefix(
    optimisticQueueUserEventId(params.queueMessageId),
    params.sessionId
  );
}

async function setUserIntentDelivery(
  preparation: UserIntentPreparation,
  status: "pending" | "sent" | "failed",
  error?: unknown
): Promise<void> {
  const next = deliveryEvent(preparation.userEvent, status, error);
  preparation.userEvent = next;
  const updated = await eventStoreProxy.updateById(
    next.id,
    { displayStatus: next.displayStatus, result: next.result },
    preparation.sessionId
  );
  if (!updated) {
    throw new Error(
      `optimistic user event ${next.id} is missing from ${preparation.sessionId}`
    );
  }
}

/**
 * Reserve a turn and persist its canonical optimistic user row before any
 * slower transcript preparation. The returned value is dispatched in that
 * same concrete Session; canonical roots keep their own queue-visible row.
 */
export async function prepareUserIntent(
  params: PrepareUserIntentParams
): Promise<UserIntentPreparation> {
  const runtimeStatusSource = params.runtimeStatusSource ?? "dispatch";
  const generation = beginTurnDispatch(params.sessionId);
  publishTurnIntentDispatch(params.turnIntentId, {
    sessionId: params.sessionId,
    generation,
  });
  beginOptimisticTurn(params.sessionId, runtimeStatusSource);

  let userEvent: SessionEvent | null = null;
  try {
    await params.beforeAppend?.();
    userEvent = createSyntheticUserEvent(params.sessionId, params.visibleText, {
      imageDataUrls: params.imageDataUrls,
      turnIntentId: params.turnIntentId,
      deliveryStatus: "pending",
      queueMessageId: params.queueMessageId,
    });
    await eventStoreProxy.append([userEvent], params.sessionId);
    const preparation = {
      sessionId: params.sessionId,
      userEvent,
      generation,
      turnIntentId: params.turnIntentId,
      runtimeStatusSource,
    };
    preparationStates.set(preparation, "prepared");
    return preparation;
  } catch (error) {
    failOptimisticTurn(params.sessionId, runtimeStatusSource);
    markTurnTerminal(params.sessionId, "failed", { generation });
    if (userEvent) {
      const failed = deliveryEvent(userEvent, "failed", error);
      await eventStoreProxy
        .updateById(
          failed.id,
          { displayStatus: failed.displayStatus, result: failed.result },
          params.sessionId
        )
        .catch(() => false);
    }
    throw error;
  }
}

/**
 * Reconnect the ordinary user-intent lifecycle to an already accepted native
 * turn. Keeping this beside prepareUserIntent is important: both fresh sends
 * and crash recovery must publish the same turnIntentId -> generation mapping
 * consumed by the CLI/Agent lifecycle coordinators.
 */
export function adoptAcceptedUserIntent(params: {
  sessionId: string;
  turnIntentId: string;
  runtimeStatusSource?: SessionRuntimeStatusSource;
}): AdoptedUserIntent {
  const runtimeStatusSource = params.runtimeStatusSource ?? "dispatch";
  const generation = beginTurnDispatch(params.sessionId);
  publishTurnIntentDispatch(params.turnIntentId, {
    sessionId: params.sessionId,
    generation,
  });
  beginOptimisticTurn(params.sessionId, runtimeStatusSource);
  confirmTurnRunning(params.sessionId);
  return {
    sessionId: params.sessionId,
    generation,
    turnIntentId: params.turnIntentId,
    runtimeStatusSource,
  };
}

/**
 * Close the exact lifecycle generation after its authoritative native tail
 * has settled. Provider adapters normally report this first; recovery calls
 * this idempotently because the original terminal event may predate renderer
 * attachment.
 */
export function settleUserIntentLifecycle(
  intent: Pick<AdoptedUserIntent, "sessionId" | "generation">,
  status: TurnTerminalStatus
): boolean {
  return markTurnTerminal(intent.sessionId, status, {
    generation: intent.generation,
  });
}

/** Keep a long pre-dispatch materialization outside the dispatch dead-man. */
export function confirmUserIntentPreparation(
  preparation: UserIntentPreparation
): void {
  confirmTurnRunning(preparation.sessionId);
}

/**
 * Re-assert the optimistic runtime mirror after a foreground continuation has
 * switched from its source Session to the newly materialized execution
 * Session. The initial preparation intentionally happens before navigation so
 * the user's row is visible immediately, but the session-scoped runtime-status
 * gate drops that target write while the source Session still owns the view.
 */
export function activateUserIntentPreparation(
  preparation: UserIntentPreparation
): void {
  beginOptimisticTurn(preparation.sessionId, preparation.runtimeStatusSource);
}

/** Keep an accepted Send visible as a failed row instead of retracting it. */
export async function failUserIntentPreparation(
  preparation: UserIntentPreparation,
  error: unknown
): Promise<void> {
  if (preparationStates.get(preparation) !== "prepared") return;
  failOptimisticTurn(preparation.sessionId, preparation.runtimeStatusSource);
  markTurnTerminal(preparation.sessionId, "failed", {
    generation: preparation.generation,
  });
  await setUserIntentDelivery(preparation, "failed", error);
  // Do not retire the preparation until the failed row crossed its durable
  // EventStore barrier. A transient SQLite failure must remain retryable by
  // the caller instead of converting a memory-only bubble into the sole owner.
  preparationStates.set(preparation, "failed");
}

async function resolveUserIntentPreparation(
  params: DispatchUserIntentParams
): Promise<UserIntentPreparation> {
  const existing = params.preparation;
  if (!existing) {
    return prepareUserIntent({
      sessionId: params.sessionId,
      visibleText: params.visibleText,
      imageDataUrls: params.imageDataUrls,
      turnIntentId: params.send.turnIntentId,
      runtimeStatusSource: params.runtimeStatusSource,
      beforeAppend: params.beforeAppend,
      queueMessageId: params.queueMessageId,
    });
  }
  const state = preparationStates.get(existing);
  if (
    state !== "prepared" ||
    existing.sessionId !== params.sessionId ||
    existing.turnIntentId !== params.send.turnIntentId
  ) {
    const error = new Error(
      "prepared user intent does not match this dispatch"
    );
    if (state === "prepared") {
      await failUserIntentPreparation(existing, error);
    }
    throw error;
  }
  // Native materialization may replace EventStore between preparation and
  // dispatch. Append is ID-deduped, so restore the exact same optimistic row.
  try {
    await eventStoreProxy.append([existing.userEvent], params.sessionId);
    return existing;
  } catch (error) {
    await failUserIntentPreparation(existing, error);
    throw error;
  }
}

/**
 * Persist one user row and hand the exact turn to SessionService. Backend
 * acceptance promotes the reserved generation to working; any pre-acceptance
 * failure keeps that same row visible as failed and closes its generation.
 */
export async function dispatchUserIntent(
  params: DispatchUserIntentParams
): Promise<DispatchUserIntentResult> {
  const preparation = await resolveUserIntentPreparation(params);
  try {
    await deliverOptimisticOutgoing({
      send: () =>
        SessionService.sendMessage({
          sessionId: params.sessionId,
          ...params.send,
          imageDataUrls: params.imageDataUrls,
        }),
      markSent: () => setUserIntentDelivery(preparation, "sent"),
      markFailed: (error) => failUserIntentPreparation(preparation, error),
      onProjectionError: (phase, error) => {
        log.error(
          `Failed to project ${phase} delivery for ${params.sessionId}`,
          error
        );
      },
    });
  } catch (error) {
    // markFailed is idempotent and already patched the same EventStore row.
    await failUserIntentPreparation(preparation, error);
    throw new UserIntentSendError(error, preparation.userEvent.id);
  }
  // Transport acceptance is the delivery boundary. Later local bookkeeping
  // must never downgrade that same row from sent to failed.
  preparationStates.set(preparation, "accepted");
  confirmTurnRunning(params.sessionId);
  markSessionActive(params.sessionId);
  if (isCursorIdeSession(params.sessionId)) {
    getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
      sessionId: params.sessionId,
      status: "idle",
      source: preparation.runtimeStatusSource,
    });
    markTurnTerminal(params.sessionId, "completed", {
      generation: preparation.generation,
    });
  }
  return { preparation, userEvent: preparation.userEvent };
}
