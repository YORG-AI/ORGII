import type { Store } from "jotai/vanilla/store";

import {
  type QueuedMessage,
  messageQueueAtom,
  messageQueueHydratedAtom,
} from "@src/store/ui/messageQueueAtom";
import {
  loadDurableMessageQueue,
  persistDurableMessageQueue,
} from "@src/store/ui/messageQueueRepository";

const hydrationByStore = new WeakMap<Store, Promise<void>>();
const unsubscribeByStore = new WeakMap<Store, () => void>();

function mergeQueues(
  durable: readonly QueuedMessage[],
  live: readonly QueuedMessage[]
): QueuedMessage[] {
  const byIntent = new Map<string, QueuedMessage>();
  // A persisted row may have crossed the backend-ACK/dequeue crash window. On
  // recovery we cannot prove whether it was accepted, so never auto-replay it:
  // keep it visible and require an explicit Send Now. Live rows created during
  // hydration are known to belong to this renderer and therefore retain their
  // natural dispatch policy.
  for (const message of durable) {
    byIntent.set(message.turnIntentId, {
      ...message,
      priority: "next",
      requiresExplicitDispatch: true,
    });
  }
  // Live mutations made while the async disk read was pending win.
  for (const message of live) byIntent.set(message.turnIntentId, message);
  return [...byIntent.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
}

/**
 * Hydrate then subscribe one Jotai store. The WeakMap ownership supports test
 * stores and multiple windows without app-lifetime listener leaks.
 */
export function hydrateMessageQueue(store: Store): Promise<void> {
  const existing = hydrationByStore.get(store);
  if (existing) return existing;

  const hydration = loadDurableMessageQueue()
    .then((durable) => {
      store.set(messageQueueAtom, (live) => mergeQueues(durable, live));
      store.set(messageQueueHydratedAtom, true);
      void persistDurableMessageQueue(store.get(messageQueueAtom));
      if (!unsubscribeByStore.has(store)) {
        const unsubscribe = store.sub(messageQueueAtom, () => {
          void persistDurableMessageQueue(store.get(messageQueueAtom));
        });
        unsubscribeByStore.set(store, unsubscribe);
      }
    })
    .catch(() => {
      // The repository already logs the root error. Keep the queue usable in
      // memory rather than blocking all sends when persistence is unavailable.
      store.set(messageQueueHydratedAtom, true);
    });

  hydrationByStore.set(store, hydration);
  return hydration;
}

export function disposeMessageQueuePersistence(store: Store): void {
  unsubscribeByStore.get(store)?.();
  unsubscribeByStore.delete(store);
  hydrationByStore.delete(store);
  store.set(messageQueueHydratedAtom, false);
}
