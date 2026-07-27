import { type Store, load } from "@tauri-apps/plugin-store";

import { createLogger } from "@src/hooks/logger";

import type { QueuedMessage } from "./messageQueueAtom";

const log = createLogger("messageQueueRepository");
const STORE_PATH = "chat-message-queue.json";
const STORE_KEY_PREFIX = "queue";

let storePromise: Promise<Store | null> | null = null;
let queueKeyPromise: Promise<string> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedMessage>;
  return (
    typeof item.id === "string" &&
    typeof item.turnIntentId === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.content === "string" &&
    typeof item.displayContent === "string" &&
    (item.priority === "now" || item.priority === "next") &&
    item.status === "queued" &&
    typeof item.createdAt === "string"
  );
}

async function durableStore(): Promise<Store | null> {
  if (storePromise) return storePromise;
  storePromise = load(STORE_PATH, {
    defaults: {},
    autoSave: false,
  }).catch((error) => {
    log.warn("[messageQueueRepository] durable store unavailable", error);
    // Do not memoize a transient startup/plugin failure forever. Queue writes
    // remain serialized, and the next mutation gets one fresh load attempt.
    storePromise = null;
    return null;
  });
  return storePromise;
}

async function queueKey(): Promise<string> {
  if (queueKeyPromise) return queueKeyPromise;
  queueKeyPromise = import("@tauri-apps/api/window")
    .then(
      ({ getCurrentWindow }) =>
        `${STORE_KEY_PREFIX}:${getCurrentWindow().label}`
    )
    .catch(() => `${STORE_KEY_PREFIX}:browser`);
  return queueKeyPromise;
}

/** Load this window's durable queue. Invalid rows are ignored, never dispatched. */
export async function loadDurableMessageQueue(): Promise<QueuedMessage[]> {
  const store = await durableStore();
  if (!store) return [];
  try {
    const stored = await store.get<unknown>(await queueKey());
    if (!Array.isArray(stored)) return [];
    return stored.filter(isQueuedMessage);
  } catch (error) {
    log.warn("[messageQueueRepository] failed to load queue", error);
    return [];
  }
}

/**
 * Serialize writes so a rapid enqueue/reorder/dequeue burst cannot let an older
 * async save overwrite a newer snapshot. Writes are explicitly saved before
 * the mutation promise resolves, so app shutdown cannot race a deferred
 * autosave after the in-memory queue has already changed.
 */
export function persistDurableMessageQueue(
  messages: readonly QueuedMessage[]
): Promise<void> {
  const snapshot = messages.map((message) => ({ ...message }));
  writeChain = writeChain
    .catch((error) => {
      // A transient failure must not poison the serialization chain. The next
      // queue mutation gets a fresh save attempt with its complete snapshot.
      log.warn("[messageQueueRepository] previous queue save failed", error);
    })
    .then(async () => {
      const store = await durableStore();
      if (!store) return;
      await store.set(await queueKey(), snapshot);
      await store.save();
    });
  return writeChain.catch((error) => {
    log.warn("[messageQueueRepository] failed to persist queue", error);
  });
}

export function resetMessageQueueRepositoryForTests(): void {
  storePromise = null;
  queueKeyPromise = null;
  writeChain = Promise.resolve();
}
