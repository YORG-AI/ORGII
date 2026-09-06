import type { Store } from "jotai/vanilla/store";

import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import {
  type Snapshot,
  eventStoreProxy,
  isStreamingSnapshot,
} from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  isOptimisticQueueUserEventId,
  optimisticQueueUserEventId,
  removeOptimisticQueueUserDelivery,
} from "@src/engines/SessionCore/services/userIntentDispatch";
import { createLogger } from "@src/hooks/logger";
import {
  type ActiveMessageDelivery,
  type MessageDeliveryRecord,
  type QueuedMessage,
  boundQueuedMessages,
  isActiveMessageDelivery,
  isQueuedMessageDelivery,
  messageDeliveryRecordsAtom,
  messageQueueAtom,
  messageQueueHandoffIdsAtom,
  messageQueueHydratedAtom,
} from "@src/store/ui/messageQueueAtom";
import {
  type ActiveMessageDeliveryUpdate,
  assertDurableActiveDeliveryIsRootHead,
  findDurableMessageDeliveryOwnerIds,
  handoffDurableMessageDelivery,
  loadDurableMessageDeliveries,
  persistDurableMessageQueue,
  removeDurableActiveMessageDelivery,
  removeDurableQueuedMessageDeliveries,
  returnDurableMessageDeliveryToQueue,
  updateDurableActiveMessageDelivery,
} from "@src/store/ui/messageQueueRepository";

const log = createLogger("MessageQueuePersistence");
const MUTATION_CHANNEL_NAME = "orgii:message-deliveries";
const MAX_RECONCILED_ORPHAN_SESSIONS = 100;
const ORPHAN_SCAN_TAIL_SIZE = 25;
const ORPHANED_QUEUE_DELIVERY_ERROR =
  "This message was not sent because its pending delivery could not be recovered. Retry to send it again.";

const queueRevisionByStore = new WeakMap<Store, number>();
const queuePersistByStore = new WeakMap<Store, Promise<void>>();
const lastObservedQueueByStore = new WeakMap<Store, readonly QueuedMessage[]>();
const hydrationByStore = new WeakMap<Store, Promise<void>>();
const unsubscribeByStore = new WeakMap<Store, () => void>();
const mutationGenerationByStore = new WeakMap<Store, number>();
const externalRefreshByStore = new WeakMap<Store, Promise<void>>();
const orphanReconciliationUnsubscribeByStore = new WeakMap<Store, () => void>();
const reconciledOrphanSessionsByStore = new WeakMap<Store, Set<string>>();
const orphanReconciliationInFlightByStore = new WeakMap<
  Store,
  Map<string, Promise<void>>
>();
const hydratedStores = new Set<Store>();
let mutationChannel: BroadcastChannel | null = null;

function sameQueue(
  left: readonly QueuedMessage[] | undefined,
  right: readonly QueuedMessage[]
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((message, index) => message === right[index])
  );
}

function persistQueueBestEffort(store: Store): Promise<void> {
  const write = persistDurableMessageQueue(store.get(messageQueueAtom));
  queuePersistByStore.set(store, write);
  void write.catch((error) => {
    console.warn("[messageQueuePersistence] failed to persist queue", error);
  });
  return write;
}

/**
 * Wait until the current queue projection has reached the existing durable
 * delivery registry. Callers use this as a commit barrier before publishing
 * side effects whose recovery depends on that queue row.
 */
export async function flushMessageQueuePersistence(
  store: Store
): Promise<void> {
  let write = queuePersistByStore.get(store) ?? persistQueueBestEffort(store);
  for (;;) {
    await write;
    const latest = queuePersistByStore.get(store);
    if (!latest || latest === write) return;
    write = latest;
  }
}

function installQueuePersistence(store: Store): void {
  if (unsubscribeByStore.has(store)) return;
  lastObservedQueueByStore.set(store, store.get(messageQueueAtom));
  const unsubscribe = store.sub(messageDeliveryRecordsAtom, () => {
    const queue = store.get(messageQueueAtom);
    if (sameQueue(lastObservedQueueByStore.get(store), queue)) return;
    lastObservedQueueByStore.set(store, queue);
    queueRevisionByStore.set(store, (queueRevisionByStore.get(store) ?? 0) + 1);
    persistQueueBestEffort(store);
  });
  unsubscribeByStore.set(store, unsubscribe);
}

function mergeHydratedQueue(
  durable: readonly QueuedMessage[],
  live: readonly QueuedMessage[],
  active: readonly ActiveMessageDelivery[]
): QueuedMessage[] {
  const activeIntents = new Set(active.map((row) => row.turnIntentId));
  const byIntent = new Map<string, QueuedMessage>();
  for (const message of durable) {
    if (activeIntents.has(message.turnIntentId)) continue;
    // Plain legacy rows can still straddle the old backend-ACK/dequeue crash
    // window, so recovery parks them for an explicit Send Now. Canonical rows
    // cross provider acceptance only after an atomic queued -> active owner
    // handoff; a row that is still queued was never accepted and is therefore
    // safe to drain with its persisted priority/hold state. Preserve an
    // explicit admission, Stop, or failure hold instead of inventing one for
    // every canonical row after each app restart.
    byIntent.set(
      message.turnIntentId,
      message.conversationDispatch
        ? message
        : {
            ...message,
            priority: "next",
            requiresExplicitDispatch: true,
          }
    );
  }
  for (const message of live) {
    if (!activeIntents.has(message.turnIntentId)) {
      byIntent.set(message.turnIntentId, message);
    }
  }
  return boundQueuedMessages(
    [...byIntent.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    )
  );
}

function publishRecords(
  store: Store,
  queue: readonly QueuedMessage[],
  active: readonly ActiveMessageDelivery[]
): void {
  const nextQueue = [...queue];
  lastObservedQueueByStore.set(store, nextQueue);
  store.set(messageDeliveryRecordsAtom, [...nextQueue, ...active]);
}

function mutationGeneration(store: Store): number {
  return mutationGenerationByStore.get(store) ?? 0;
}

function noteLocalMutation(store: Store): void {
  mutationGenerationByStore.set(store, mutationGeneration(store) + 1);
}

function ensureMutationChannel(): BroadcastChannel | null {
  if (mutationChannel || typeof BroadcastChannel === "undefined") {
    return mutationChannel;
  }
  mutationChannel = new BroadcastChannel(MUTATION_CHANNEL_NAME);
  mutationChannel.addEventListener("message", () => {
    for (const store of hydratedStores) {
      mutationGenerationByStore.set(store, mutationGeneration(store) + 1);
      if (externalRefreshByStore.has(store)) continue;
      const refresh = (async () => {
        let observed: number;
        do {
          observed = mutationGeneration(store);
          await refreshMessageDeliveries(store);
        } while (observed !== mutationGeneration(store));
      })()
        .catch((error) =>
          console.warn(
            "[messageQueuePersistence] cross-window refresh failed",
            error
          )
        )
        .finally(() => externalRefreshByStore.delete(store));
      externalRefreshByStore.set(store, refresh);
    }
  });
  return mutationChannel;
}

function broadcastMutation(): void {
  ensureMutationChannel()?.postMessage({ type: "changed" });
}

function pendingQueueMessageId(event: SessionEvent): string | null {
  const queueMessageId = event.result?.queueMessageId;
  if (
    event.source !== "user" ||
    event.displayStatus !== "pending" ||
    event.result?.deliveryStatus !== "pending" ||
    event.result?.syntheticUserInput !== true ||
    typeof queueMessageId !== "string" ||
    !isOptimisticQueueUserEventId(event.id) ||
    event.id !== optimisticQueueUserEventId(queueMessageId)
  ) {
    return null;
  }
  return queueMessageId;
}

function rememberReconciledSession(store: Store, sessionId: string): void {
  const sessions = reconciledOrphanSessionsByStore.get(store) ?? new Set();
  sessions.delete(sessionId);
  sessions.add(sessionId);
  while (sessions.size > MAX_RECONCILED_ORPHAN_SESSIONS) {
    const oldest = sessions.values().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
  reconciledOrphanSessionsByStore.set(store, sessions);
}

/**
 * Fail legacy pending queue projections that have no execution owner.
 *
 * The durable registry is read after the EventStore candidate snapshot, so a
 * correctly admitted message (owner committed before projection append) can
 * never be classified as an orphan. A second EventStore read rejects a row
 * that became sent/failed while the owner was settling. The visible user row
 * remains intact; only its stale queue ownership claim is removed so Retry
 * can re-enter the canonical submit path.
 */
export async function reconcileOrphanedOptimisticQueueProjections(
  sessionId: string
): Promise<boolean> {
  const events = await eventStoreProxy.getEvents(sessionId);
  if (events.length === 0) return false;
  const candidateIds = events
    .map(pendingQueueMessageId)
    .filter((id): id is string => Boolean(id));
  if (candidateIds.length === 0) return true;

  const ownerIds = await findDurableMessageDeliveryOwnerIds(candidateIds);
  const orphanIds = new Set(candidateIds.filter((id) => !ownerIds.has(id)));
  if (orphanIds.size === 0) return true;

  // Re-read after the durable lookup. Provider acceptance patches pending to
  // sent before retiring its active owner; never delete that accepted row on
  // the basis of the earlier snapshot.
  const currentOrphans = (await eventStoreProxy.getEvents(sessionId)).filter(
    (event) => {
      const queueMessageId = pendingQueueMessageId(event);
      return Boolean(queueMessageId && orphanIds.has(queueMessageId));
    }
  );
  await Promise.all(
    currentOrphans.map(async (event) => {
      const result = {
        ...event.result,
        deliveryStatus: "failed",
        deliveryError: ORPHANED_QUEUE_DELIVERY_ERROR,
      };
      // A queueMessageId is a strong durable-ownership claim in Retry. The
      // owner is proven absent, so retaining it would make Retry fail closed
      // forever instead of using the ordinary submit/queue boundary.
      Reflect.deleteProperty(result, "queueMessageId");
      const updated = await eventStoreProxy.updateById(
        event.id,
        { displayStatus: "failed", result },
        sessionId
      );
      if (!updated) {
        throw new Error(
          `orphaned queue projection ${event.id} is no longer available`
        );
      }
    })
  );
  return true;
}

function reconcileOrphanSessionOnce(
  store: Store,
  sessionId: string
): Promise<void> {
  if (reconciledOrphanSessionsByStore.get(store)?.has(sessionId)) {
    return Promise.resolve();
  }
  const inFlight = orphanReconciliationInFlightByStore.get(store) ?? new Map();
  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  orphanReconciliationInFlightByStore.set(store, inFlight);
  const reconciliation = reconcileOrphanedOptimisticQueueProjections(sessionId)
    .then((inspected) => {
      if (inspected) rememberReconciledSession(store, sessionId);
    })
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, reconciliation);
  return reconciliation;
}

function installOrphanProjectionReconciliation(store: Store): void {
  if (orphanReconciliationUnsubscribeByStore.has(store)) return;
  const inspectSnapshot = (snapshot: Snapshot, sessionId: string) => {
    if (!store.get(messageQueueHydratedAtom)) return;
    if (reconciledOrphanSessionsByStore.get(store)?.has(sessionId)) return;
    if (!isStreamingSnapshot(snapshot) && snapshot.eventCount > 0) {
      void reconcileOrphanSessionOnce(store, sessionId).catch((error) =>
        log.warn(
          "[messageQueuePersistence] orphan projection reconciliation failed",
          { sessionId, error }
        )
      );
      return;
    }
    const tail = snapshot.chatEvents.slice(-ORPHAN_SCAN_TAIL_SIZE);
    const hasCandidate = tail.some((event) => pendingQueueMessageId(event));
    if (!hasCandidate) return;
    void reconcileOrphanSessionOnce(store, sessionId).catch((error) =>
      log.warn(
        "[messageQueuePersistence] orphan projection reconciliation failed",
        { sessionId, error }
      )
    );
  };
  orphanReconciliationUnsubscribeByStore.set(
    store,
    eventStoreProxy.subscribe(inspectSnapshot)
  );
}

function hydrateMessageQueueFromSnapshot(
  store: Store,
  durable: readonly QueuedMessage[],
  active: readonly ActiveMessageDelivery[] = []
): void {
  const queue = mergeHydratedQueue(
    durable,
    store.get(messageQueueAtom),
    active
  );
  publishRecords(store, queue, active);
  installQueuePersistence(store);
}

/** One hydration owner for queued, preparing, and accepted deliveries. */
export function hydrateMessageQueue(store: Store): Promise<void> {
  const existing = hydrationByStore.get(store);
  if (existing) return existing;
  hydratedStores.add(store);
  ensureMutationChannel();
  const hydration = (async () => {
    try {
      let generation = mutationGeneration(store);
      let snapshot = await loadDurableMessageDeliveries();
      while (generation !== mutationGeneration(store)) {
        generation = mutationGeneration(store);
        snapshot = await loadDurableMessageDeliveries();
      }
      hydrateMessageQueueFromSnapshot(store, snapshot.queue, snapshot.active);
      await persistQueueBestEffort(store);
      store.set(messageQueueHydratedAtom, true);
      installOrphanProjectionReconciliation(store);
      const activeSessionId = store.get(sessionIdAtom);
      if (activeSessionId) {
        await reconcileOrphanSessionOnce(store, activeSessionId).catch(
          (error) =>
            log.warn(
              "[messageQueuePersistence] initial orphan projection reconciliation failed",
              { sessionId: activeSessionId, error }
            )
        );
      }
    } catch (error) {
      store.set(messageQueueHydratedAtom, false);
      hydrationByStore.delete(store);
      hydratedStores.delete(store);
      throw error;
    }
  })();
  hydrationByStore.set(store, hydration);
  return hydration;
}

/** Reconcile the live projections with the single durable delivery registry. */
export async function refreshMessageDeliveries(store: Store): Promise<void> {
  for (;;) {
    const revision = queueRevisionByStore.get(store) ?? 0;
    await queuePersistByStore.get(store);
    const snapshot = await loadDurableMessageDeliveries();
    if (revision !== (queueRevisionByStore.get(store) ?? 0)) continue;
    publishRecords(store, snapshot.queue, snapshot.active);
    return;
  }
}

/**
 * Cancel exact, still-queued deliveries and their optimistic EventStore rows.
 *
 * The handoff set is the existing queue mutation freeze. Holding it across
 * both durable stores prevents the dispatcher, edit, cancel, and reorder
 * paths from racing this ownership transition. Rows that have already moved
 * to `preparing`/`accepted` are rejected by the repository and remain intact.
 */
export async function cancelQueuedMessageDeliveries(
  store: Store,
  messageIds: readonly string[]
): Promise<void> {
  if (messageIds.length === 0) return;
  const requestedIds = new Set(messageIds);
  const alreadyFrozen = store.get(messageQueueHandoffIdsAtom);
  const candidates = store
    .get(messageQueueAtom)
    .filter(
      (message) =>
        requestedIds.has(message.id) && !alreadyFrozen.has(message.id)
    );
  if (candidates.length === 0) return;

  const candidateIds = new Set(candidates.map((message) => message.id));
  store.set(messageQueueHandoffIdsAtom, (current) => {
    const next = new Set(current);
    for (const id of candidateIds) next.add(id);
    return next;
  });

  try {
    const removed = await removeDurableQueuedMessageDeliveries(
      candidates.map(({ id, turnIntentId }) => ({ id, turnIntentId }))
    );
    if (removed.length === 0) return;

    const removals = await Promise.allSettled(
      removed.map(async (message) => {
        await removeOptimisticQueueUserDelivery({
          sessionId: message.sessionId,
          queueMessageId: message.id,
        });
        return message;
      })
    );
    const cancelledIds = new Set<string>();
    const failed: QueuedMessage[] = [];
    for (let index = 0; index < removals.length; index += 1) {
      const result = removals[index];
      const message = removed[index];
      if (!message) continue;
      if (result?.status === "fulfilled") cancelledIds.add(message.id);
      else failed.push(message);
    }

    // If EventStore cleanup fails, restore only those rows as cancellable
    // queue owners. Successful cancellations remain absent. The current live
    // queue is the existing authority for concurrent enqueues and preserves
    // their order and payloads in the same snapshot transaction.
    if (failed.length > 0) {
      await persistDurableMessageQueue(
        store
          .get(messageQueueAtom)
          .filter((message) => !cancelledIds.has(message.id))
      );
    }

    noteLocalMutation(store);
    const records = store.get(messageDeliveryRecordsAtom);
    publishRecords(
      store,
      records
        .filter(isQueuedMessageDelivery)
        .filter((message) => !cancelledIds.has(message.id)),
      records.filter(isActiveMessageDelivery)
    );
    broadcastMutation();

    if (failed.length > 0) {
      const firstFailure = removals.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      const detail =
        firstFailure?.reason instanceof Error
          ? `: ${firstFailure.reason.message}`
          : "";
      throw new Error(
        `failed to remove ${failed.length} optimistic queued message projection(s)${detail}`
      );
    }
  } finally {
    store.set(messageQueueHandoffIdsAtom, (current) => {
      if (![...candidateIds].some((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of candidateIds) next.delete(id);
      return next;
    });
  }
}

export async function handoffQueuedMessageToActiveDelivery(
  store: Store,
  delivery: ActiveMessageDelivery
): Promise<void> {
  const result = await handoffDurableMessageDelivery(delivery);
  noteLocalMutation(store);
  const records = store.get(messageDeliveryRecordsAtom);
  const queue = records
    .filter(isQueuedMessageDelivery)
    .filter((message) => message.turnIntentId !== delivery.turnIntentId);
  publishRecords(store, queue, result.active);
  broadcastMutation();
}

export async function returnActiveDeliveryToMessageQueue(
  store: Store,
  deliveryId: string,
  message: QueuedMessage
): Promise<boolean> {
  store.set(messageQueueHandoffIdsAtom, (current) => {
    const next = new Set(current);
    next.add(message.id);
    return next;
  });
  try {
    const result = await returnDurableMessageDeliveryToQueue(
      deliveryId,
      message
    );
    noteLocalMutation(store);
    const records = store.get(messageDeliveryRecordsAtom);
    const queue = [
      ...records
        .filter(isQueuedMessageDelivery)
        .filter(
          (candidate) =>
            candidate.id !== result.message.id &&
            candidate.turnIntentId !== result.message.turnIntentId
        ),
      result.message,
    ];
    publishRecords(store, queue, result.active);
    broadcastMutation();
    return true;
  } finally {
    store.set(messageQueueHandoffIdsAtom, (current) => {
      if (!current.has(message.id)) return current;
      const next = new Set(current);
      next.delete(message.id);
      return next;
    });
  }
}

export async function updateActiveMessageDelivery(
  store: Store,
  deliveryId: string,
  update: ActiveMessageDeliveryUpdate
): Promise<ActiveMessageDelivery | null> {
  const updated = await updateDurableActiveMessageDelivery(deliveryId, update);
  noteLocalMutation(store);
  if (updated) {
    const records = store.get(messageDeliveryRecordsAtom);
    publishRecords(
      store,
      records.filter(isQueuedMessageDelivery),
      records
        .filter(isActiveMessageDelivery)
        .map((candidate) => (candidate.id === deliveryId ? updated : candidate))
    );
  }
  broadcastMutation();
  return updated;
}

export async function removeActiveMessageDelivery(
  store: Store,
  deliveryId: string
): Promise<void> {
  await removeDurableActiveMessageDelivery(deliveryId);
  noteLocalMutation(store);
  const records = store.get(messageDeliveryRecordsAtom);
  publishRecords(
    store,
    records.filter(isQueuedMessageDelivery),
    records
      .filter(isActiveMessageDelivery)
      .filter((candidate) => candidate.id !== deliveryId)
  );
  broadcastMutation();
}

export { assertDurableActiveDeliveryIsRootHead };

export function disposeMessageQueuePersistence(store: Store): void {
  unsubscribeByStore.get(store)?.();
  unsubscribeByStore.delete(store);
  hydrationByStore.delete(store);
  queueRevisionByStore.delete(store);
  queuePersistByStore.delete(store);
  lastObservedQueueByStore.delete(store);
  mutationGenerationByStore.delete(store);
  externalRefreshByStore.delete(store);
  orphanReconciliationUnsubscribeByStore.get(store)?.();
  orphanReconciliationUnsubscribeByStore.delete(store);
  reconciledOrphanSessionsByStore.delete(store);
  orphanReconciliationInFlightByStore.delete(store);
  hydratedStores.delete(store);
  store.set(messageQueueHydratedAtom, false);
  if (hydratedStores.size === 0) {
    mutationChannel?.close();
    mutationChannel = null;
  }
}

export function replaceActiveMessageDeliveryLocally(
  store: Store,
  deliveryId: string,
  update: ActiveMessageDeliveryUpdate
): void {
  store.set(messageDeliveryRecordsAtom, (records: MessageDeliveryRecord[]) =>
    records.map((record) =>
      isActiveMessageDelivery(record) && record.id === deliveryId
        ? { ...record, ...update }
        : record
    )
  );
}
