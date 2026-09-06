import { type Store, load } from "@tauri-apps/plugin-store";

import { conversationRootKey } from "@src/engines/SessionCore/conversations/conversationTypes";
import {
  MAX_QUEUED_CONVERSATION_MESSAGE_CHARS_TOTAL,
  QueuedConversationBusyError,
  QueuedConversationRecoveryPendingError,
  isQueuedConversationMessagePayload,
  queuedConversationMessageCharSize,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { createLogger } from "@src/hooks/logger";

import {
  type ActiveMessageDelivery,
  MAX_QUEUED_MESSAGE_CHARS,
  type QueuedMessage,
  boundQueuedMessages,
  queueAdmissionResult,
  queuedMessageCharSize,
} from "./messageQueueAtom";

const log = createLogger("messageQueueRepository");
const STORE_PATH = "chat-message-queue.json";
const STORE_KEY_PREFIX = "queue";
const DELIVERY_RECORDS_KEY = "deliveries";
const STORE_LOCK_NAME = "orgii:chat-message-queue-store";
const CONVERSATION_TURN_LOCK_PREFIX = "orgii:canonical-conversation:";
const MAX_ACTIVE_DELIVERIES = 100;

function isMissingStoreFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No such file or directory") ||
    message.includes("os error 2")
  );
}

let storePromise: Promise<Store | null> | null = null;
let queueKeyPromise: Promise<string> | null = null;
let mutationChain: Promise<unknown> = Promise.resolve();
let fallbackStoreLock: Promise<unknown> = Promise.resolve();
let legacyQueueMigrationComplete = false;

async function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return await locks.request(
      STORE_LOCK_NAME,
      { mode: "exclusive" },
      operation
    );
  }
  const next = fallbackStoreLock.catch(() => undefined).then(operation);
  fallbackStoreLock = next;
  return await next;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedMessage>;
  const validConversationDispatch = item.conversationDispatch
    ? isQueuedConversationMessagePayload(item)
    : true;
  return (
    typeof item.id === "string" &&
    typeof item.turnIntentId === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.content === "string" &&
    typeof item.displayContent === "string" &&
    validConversationDispatch &&
    (item.imageDataUrls === undefined ||
      (Array.isArray(item.imageDataUrls) &&
        item.imageDataUrls.every((image) => typeof image === "string"))) &&
    (item.deliveryError === undefined ||
      typeof item.deliveryError === "string") &&
    (item.priority === "now" || item.priority === "next") &&
    item.status === "queued" &&
    typeof item.createdAt === "string" &&
    queuedMessageCharSize(item as QueuedMessage) <= MAX_QUEUED_MESSAGE_CHARS
  );
}

type DurableQueuedMessage = QueuedMessage & { originQueueKey: string };
type DurableMessageDelivery = DurableQueuedMessage | ActiveMessageDelivery;

function hasQueueOwner(value: unknown): value is { originQueueKey: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { originQueueKey?: unknown }).originQueueKey ===
      "string" &&
    (value as { originQueueKey: string }).originQueueKey.startsWith("queue:")
  );
}

function isDurableQueuedMessage(value: unknown): value is DurableQueuedMessage {
  return isQueuedMessage(value) && hasQueueOwner(value);
}

function toQueuedMessage(record: DurableQueuedMessage): QueuedMessage {
  const { originQueueKey: _originQueueKey, ...message } = record;
  return message;
}

export function validatedDurableMessageQueue(value: unknown): QueuedMessage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isQueuedMessage)) {
    throw new Error("durable message queue contains an invalid row");
  }
  const ids = new Set<string>();
  const intents = new Set<string>();
  for (const message of value) {
    if (ids.has(message.id) || intents.has(message.turnIntentId)) {
      throw new Error("durable message queue contains duplicate identity");
    }
    ids.add(message.id);
    intents.add(message.turnIntentId);
  }
  const bounded = boundQueuedMessages(value);
  if (bounded.length !== value.length) {
    throw new Error("durable message queue exceeds its safety limits");
  }
  return value;
}

function isActiveDelivery(value: unknown): value is ActiveMessageDelivery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActiveMessageDelivery>;
  const retryAt = candidate.retryAt;
  const retryAttempt = candidate.retryAttempt;
  const validMetadata = Boolean(
    typeof candidate.id === "string" &&
    (candidate.status === "preparing" || candidate.status === "accepted") &&
    (candidate.priority === "now" || candidate.priority === "next") &&
    (candidate.runnerSessionId === undefined ||
      (typeof candidate.runnerSessionId === "string" &&
        candidate.runnerSessionId.length > 0)) &&
    (candidate.status !== "accepted" ||
      typeof candidate.runnerSessionId === "string") &&
    (candidate.runnerEventStartIndex === undefined ||
      (typeof candidate.runnerEventStartIndex === "number" &&
        Number.isSafeInteger(candidate.runnerEventStartIndex) &&
        candidate.runnerEventStartIndex >= 0)) &&
    typeof candidate.createdAt === "string" &&
    (candidate.deliveryError === undefined ||
      typeof candidate.deliveryError === "string") &&
    (retryAt === undefined || typeof retryAt === "string") &&
    (retryAttempt === undefined ||
      (typeof retryAttempt === "number" &&
        Number.isSafeInteger(retryAttempt) &&
        retryAttempt >= 0))
  );
  return (
    validMetadata &&
    hasQueueOwner(value) &&
    isQueuedConversationMessagePayload(value)
  );
}

export function validatedActiveMessageDeliveries(
  value: unknown
): ActiveMessageDelivery[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("active message delivery store is not an array");
  }
  if (!value.every(isActiveDelivery)) {
    throw new Error("active message delivery store contains an invalid row");
  }
  const rows = value as ActiveMessageDelivery[];
  if (rows.length > MAX_ACTIVE_DELIVERIES) {
    throw new Error("active message delivery store exceeds its row limit");
  }
  const ids = new Set<string>();
  const intentIds = new Set<string>();
  for (const delivery of rows) {
    if (ids.has(delivery.id) || intentIds.has(delivery.turnIntentId)) {
      throw new Error(
        "active message delivery store contains duplicate ownership"
      );
    }
    ids.add(delivery.id);
    intentIds.add(delivery.turnIntentId);
  }
  const totalChars = rows.reduce(
    (total, delivery) => total + queuedConversationMessageCharSize(delivery),
    0
  );
  if (totalChars > MAX_QUEUED_CONVERSATION_MESSAGE_CHARS_TOTAL) {
    throw new Error("active message delivery store exceeds its payload limit");
  }
  return rows;
}

function validatedDurableMessageDeliveries(
  value: unknown
): DurableMessageDelivery[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (record) => isDurableQueuedMessage(record) || isActiveDelivery(record)
    )
  ) {
    throw new Error("durable message delivery store contains an invalid row");
  }
  const records = value as DurableMessageDelivery[];
  const intentIds = new Set<string>();
  const queuedIds = new Set<string>();
  for (const record of records) {
    if (intentIds.has(record.turnIntentId)) {
      throw new Error(
        "durable message delivery store contains duplicate identity"
      );
    }
    intentIds.add(record.turnIntentId);
    if (record.status === "queued") {
      if (queuedIds.has(record.id)) {
        throw new Error(
          "durable message delivery store contains duplicate identity"
        );
      }
      queuedIds.add(record.id);
    }
  }
  const active = records.filter(isActiveDelivery);
  validatedActiveMessageDeliveries(active);
  const queuedByOwner = new Map<string, DurableQueuedMessage[]>();
  for (const record of records) {
    if (record.status !== "queued") continue;
    const ownerQueue = queuedByOwner.get(record.originQueueKey) ?? [];
    ownerQueue.push(record);
    queuedByOwner.set(record.originQueueKey, ownerQueue);
  }
  for (const queue of queuedByOwner.values()) {
    validatedDurableMessageQueue(queue);
  }
  const totalChars = records.reduce(
    (total, record) => total + queuedConversationMessageCharSize(record),
    0
  );
  if (totalChars > MAX_QUEUED_CONVERSATION_MESSAGE_CHARS_TOTAL) {
    throw new Error("durable message delivery store exceeds its payload limit");
  }
  return records;
}

async function durableStore(): Promise<Store | null> {
  if (storePromise) return storePromise;
  storePromise = load(STORE_PATH, {
    defaults: {},
    autoSave: false,
  }).catch((error) => {
    log.warn("[messageQueueRepository] durable store unavailable", error);
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

export async function getMessageQueueOwnerKey(): Promise<string> {
  return await queueKey();
}

export function isPrimaryMessageQueueOwnerKey(key: string): boolean {
  return (
    key === `${STORE_KEY_PREFIX}:main` || key === `${STORE_KEY_PREFIX}:browser`
  );
}

export async function withMessageQueueStoreTransaction<T>(
  operation: (store: Store, windowQueueKey: string) => Promise<T>
): Promise<T> {
  const store = await durableStore();
  if (!store) {
    throw new Error("durable message queue store is unavailable");
  }
  return await withStoreLock(async () => {
    try {
      await store.reload();
    } catch (error) {
      if (!isMissingStoreFileError(error)) throw error;
      // Store.load() supplies the empty in-memory defaults when its file does
      // not exist, but reload() reports ENOENT. Persist that initial snapshot
      // once so the normal reload-before-transaction contract can begin.
      await store.save();
    }
    return await operation(store, await queueKey());
  });
}

export function serializeMessageQueueStoreMutation<T>(
  operation: (store: Store, windowQueueKey: string) => Promise<T>
): Promise<T> {
  const next = mutationChain
    .catch((error) => {
      log.warn("[messageQueueRepository] previous mutation failed", error);
    })
    .then(() => withMessageQueueStoreTransaction(operation));
  mutationChain = next;
  return next;
}

async function readDeliveriesLocked(
  store: Store
): Promise<DurableMessageDelivery[]> {
  const deliveries = validatedDurableMessageDeliveries(
    await store.get<unknown>(DELIVERY_RECORDS_KEY)
  );
  if (legacyQueueMigrationComplete) return deliveries;
  const legacyKeys = (await store.keys())
    .filter((key) => key.startsWith(`${STORE_KEY_PREFIX}:`))
    .sort();
  if (legacyKeys.length === 0) {
    legacyQueueMigrationComplete = true;
    return deliveries;
  }

  const legacyEntries = await Promise.all(
    legacyKeys.map(async (key) => [key, await store.get<unknown>(key)] as const)
  );
  const seenIds = new Set(deliveries.map((record) => record.id));
  const seenIntentIds = new Set(
    deliveries.map((record) => record.turnIntentId)
  );
  const migrated = [...deliveries];
  for (const [key, stored] of legacyEntries) {
    if (!Array.isArray(stored)) continue;
    const recovered = boundQueuedMessages(stored.filter(isQueuedMessage));
    for (const message of recovered) {
      if (seenIds.has(message.id) || seenIntentIds.has(message.turnIntentId)) {
        continue;
      }
      seenIds.add(message.id);
      seenIntentIds.add(message.turnIntentId);
      migrated.push({ ...message, originQueueKey: key });
    }
  }
  const validated = validatedDurableMessageDeliveries(migrated);

  // Commit the unified registry before removing any legacy owner. If this
  // save fails, every queue:<window> key remains available for a later retry.
  await store.set(DELIVERY_RECORDS_KEY, validated);
  await store.save();

  try {
    for (const key of legacyKeys) await store.delete(key);
    await store.save();
  } catch (error) {
    // Cleanup is best-effort but must not leave an in-memory Store instance
    // pretending the legacy rows were removed when its save failed. Restore
    // them so the next hydrate can retry the same idempotent migration.
    for (const [key, stored] of legacyEntries) await store.set(key, stored);
    try {
      await store.save();
    } catch (restoreError) {
      log.warn(
        "[messageQueueRepository] failed to restore legacy queue keys after cleanup failure",
        restoreError
      );
    }
    throw error;
  }
  legacyQueueMigrationComplete = true;
  return validated;
}

interface DurableMessageDeliverySnapshot {
  queue: QueuedMessage[];
  active: ActiveMessageDelivery[];
}

async function readDeliverySnapshotLocked(
  store: Store,
  windowQueueKey: string
): Promise<DurableMessageDeliverySnapshot> {
  const records = await readDeliveriesLocked(store);
  return {
    queue: records
      .filter(
        (record): record is DurableQueuedMessage =>
          record.status === "queued" && record.originQueueKey === windowQueueKey
      )
      .map(toQueuedMessage),
    active: records.filter(isActiveDelivery),
  };
}

export async function loadDurableMessageDeliveries(): Promise<DurableMessageDeliverySnapshot> {
  return await withMessageQueueStoreTransaction(readDeliverySnapshotLocked);
}

export async function loadDurableMessageQueue(): Promise<QueuedMessage[]> {
  return (await loadDurableMessageDeliveries()).queue;
}

export function persistDurableMessageQueue(
  messages: readonly QueuedMessage[]
): Promise<void> {
  const snapshot = boundQueuedMessages(messages).map((message) => ({
    ...message,
  }));
  return serializeMessageQueueStoreMutation(async (store, key) => {
    const records = await readDeliveriesLocked(store);
    const active = records.filter(isActiveDelivery);
    const activeIntentIds = new Set(active.map((row) => row.turnIntentId));
    const otherRecords = records.filter(
      (record) => record.status !== "queued" || record.originQueueKey !== key
    );
    const currentQueue = snapshot
      .filter((message) => !activeIntentIds.has(message.turnIntentId))
      .map((message) => ({ ...message, originQueueKey: key }));
    await store.set(
      DELIVERY_RECORDS_KEY,
      validatedDurableMessageDeliveries([...otherRecords, ...currentQueue])
    );
    await store.save();
  });
}

export interface QueuedMessageCancellationIdentity {
  id: string;
  turnIntentId: string;
}

/** Return which queue ids still have any durable queued/active owner. */
export function findDurableMessageDeliveryOwnerIds(
  messageIds: readonly string[]
): Promise<Set<string>> {
  const requested = new Set(messageIds);
  if (requested.size === 0) return Promise.resolve(new Set());
  return withMessageQueueStoreTransaction(async (store) => {
    const records = await readDeliveriesLocked(store);
    return new Set(
      records
        .filter((record) => requested.has(record.id))
        .map((record) => record.id)
    );
  });
}

/**
 * Remove exact queued owners from this window's durable partition.
 *
 * This is intentionally narrower than replacing the queue snapshot: a row
 * that has already moved to `preparing`/`accepted`, or belongs to another
 * window, is no longer cancellable by a stale queue card and must survive.
 */
export function removeDurableQueuedMessageDeliveries(
  identities: readonly QueuedMessageCancellationIdentity[]
): Promise<QueuedMessage[]> {
  const keys = new Set(
    identities.map(({ id, turnIntentId }) => `${id}\0${turnIntentId}`)
  );
  if (keys.size === 0) return Promise.resolve([]);

  return serializeMessageQueueStoreMutation(async (store, windowQueueKey) => {
    const records = await readDeliveriesLocked(store);
    const removed: QueuedMessage[] = [];
    const next = records.filter((record) => {
      const matches =
        record.status === "queued" &&
        record.originQueueKey === windowQueueKey &&
        keys.has(`${record.id}\0${record.turnIntentId}`);
      if (matches) removed.push(toQueuedMessage(record));
      return !matches;
    });
    if (removed.length === 0) return removed;
    await store.set(
      DELIVERY_RECORDS_KEY,
      validatedDurableMessageDeliveries(next)
    );
    await store.save();
    return removed;
  });
}

export function handoffDurableMessageDelivery(
  delivery: ActiveMessageDelivery
): Promise<{
  delivery: ActiveMessageDelivery;
  queue: QueuedMessage[];
  active: ActiveMessageDelivery[];
}> {
  return serializeMessageQueueStoreMutation(async (store, windowQueueKey) => {
    const records = await readDeliveriesLocked(store);
    const active = records.filter(isActiveDelivery);
    const queue = records
      .filter(
        (record): record is DurableQueuedMessage =>
          record.status === "queued" && record.originQueueKey === windowQueueKey
      )
      .map(toQueuedMessage);
    const existingOwner = active.find(
      (candidate) =>
        candidate.id === delivery.id &&
        candidate.turnIntentId === delivery.turnIntentId
    );
    const conflictingOwner = active.some(
      (candidate) =>
        candidate.id === delivery.id ||
        candidate.turnIntentId === delivery.turnIntentId
    );
    const sourceRow = queue.find(
      (message) =>
        message.id === delivery.id &&
        message.turnIntentId === delivery.turnIntentId
    );
    if (
      (!existingOwner && !sourceRow) ||
      (!existingOwner && conflictingOwner)
    ) {
      throw new QueuedConversationBusyError();
    }
    const persisted =
      existingOwner ??
      ({
        ...sourceRow,
        status: delivery.status,
        originQueueKey: windowQueueKey,
        runnerSessionId: delivery.runnerSessionId,
        runnerEventStartIndex: delivery.runnerEventStartIndex,
        retryAt: delivery.retryAt,
        retryAttempt: delivery.retryAttempt,
      } as ActiveMessageDelivery);
    const nextQueue = queue.filter(
      (message) =>
        message.id !== persisted.id ||
        message.turnIntentId !== persisted.turnIntentId
    );
    const nextActive = existingOwner
      ? active
      : validatedActiveMessageDeliveries([...active, persisted]);
    const nextRecords = existingOwner
      ? records.filter(
          (record) =>
            record.status !== "queued" ||
            record.originQueueKey !== windowQueueKey ||
            record.id !== persisted.id ||
            record.turnIntentId !== persisted.turnIntentId
        )
      : records.map((record) =>
          record.status === "queued" &&
          record.originQueueKey === windowQueueKey &&
          record.id === persisted.id &&
          record.turnIntentId === persisted.turnIntentId
            ? persisted
            : record
        );
    await store.set(
      DELIVERY_RECORDS_KEY,
      validatedDurableMessageDeliveries(nextRecords)
    );
    await store.save();
    return { delivery: persisted, queue: nextQueue, active: nextActive };
  });
}

export function returnDurableMessageDeliveryToQueue(
  deliveryId: string,
  message: QueuedMessage
): Promise<{
  message: QueuedMessage;
  active: ActiveMessageDelivery[];
}> {
  return serializeMessageQueueStoreMutation(async (store, claimantQueueKey) => {
    const records = await readDeliveriesLocked(store);
    const active = records.filter(isActiveDelivery);
    if (!active.some((candidate) => candidate.id === deliveryId)) {
      throw new QueuedConversationRecoveryPendingError(
        "active message delivery owner is temporarily unavailable"
      );
    }
    const queue = records
      .filter(
        (record): record is DurableQueuedMessage =>
          record.status === "queued" &&
          record.originQueueKey === claimantQueueKey
      )
      .map(toQueuedMessage);
    const supersedingMessage = queue.find(
      (candidate) =>
        candidate.id === message.id &&
        candidate.turnIntentId !== message.turnIntentId
    );
    const baseQueue = queue.filter(
      (candidate) =>
        candidate.id !== message.id &&
        candidate.turnIntentId !== message.turnIntentId
    );
    const restoredMessage = supersedingMessage ?? message;
    const rejection = queueAdmissionResult(baseQueue, restoredMessage);
    if (rejection) {
      throw new QueuedConversationRecoveryPendingError(
        `message queue cannot restore this turn yet (${rejection})`
      );
    }
    const nextActive = active.filter(
      (candidate) => candidate.id !== deliveryId
    );
    const queuedRecord: DurableQueuedMessage = {
      ...restoredMessage,
      originQueueKey: claimantQueueKey,
    };
    const nextRecords = records
      .filter(
        (record) =>
          record.id !== deliveryId &&
          !(
            record.status === "queued" &&
            record.originQueueKey === claimantQueueKey &&
            (record.id === queuedRecord.id ||
              record.turnIntentId === queuedRecord.turnIntentId)
          )
      )
      .concat(queuedRecord);
    await store.set(
      DELIVERY_RECORDS_KEY,
      validatedDurableMessageDeliveries(nextRecords)
    );
    await store.save();
    return { message: restoredMessage, active: nextActive };
  });
}

export type ActiveMessageDeliveryUpdate = Partial<
  Pick<
    ActiveMessageDelivery,
    | "status"
    | "runnerSessionId"
    | "runnerEventStartIndex"
    | "retryAt"
    | "retryAttempt"
  >
>;

export async function updateDurableActiveMessageDelivery(
  deliveryId: string,
  update: ActiveMessageDeliveryUpdate
): Promise<ActiveMessageDelivery | null> {
  let updated: ActiveMessageDelivery | null = null;
  await serializeMessageQueueStoreMutation(async (store) => {
    const records = await readDeliveriesLocked(store);
    const next = validatedDurableMessageDeliveries(
      records.map((candidate) => {
        if (candidate.status === "queued" || candidate.id !== deliveryId) {
          return candidate;
        }
        updated = { ...candidate, ...update } as ActiveMessageDelivery;
        return updated;
      })
    );
    await store.set(DELIVERY_RECORDS_KEY, next);
    await store.save();
  });
  return updated;
}

export function removeDurableActiveMessageDelivery(
  deliveryId: string
): Promise<void> {
  return serializeMessageQueueStoreMutation(async (store) => {
    const records = await readDeliveriesLocked(store);
    await store.set(
      DELIVERY_RECORDS_KEY,
      records.filter(
        (candidate) =>
          candidate.status === "queued" || candidate.id !== deliveryId
      )
    );
    await store.save();
  });
}

export function assertDurableActiveDeliveryIsRootHead(
  deliveryId: string
): Promise<ActiveMessageDelivery> {
  return withMessageQueueStoreTransaction(async (store) => {
    const active = (await readDeliveriesLocked(store)).filter(isActiveDelivery);
    const owner = active.find((candidate) => candidate.id === deliveryId);
    if (!owner) throw new QueuedConversationBusyError();
    const rootKey = conversationRootKey(owner.conversationDispatch.root);
    const head = active.find(
      (candidate) =>
        conversationRootKey(candidate.conversationDispatch.root) === rootKey
    );
    if (head?.id !== deliveryId) throw new QueuedConversationBusyError();
    return owner;
  });
}

export async function withCanonicalConversationTurnLock<T>(
  root: import("@src/engines/SessionCore/conversations/conversationTypes").ConversationRootLocator,
  run: () => Promise<T>
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) {
    throw new Error("canonical conversation lock is unavailable");
  }
  const name = `${CONVERSATION_TURN_LOCK_PREFIX}${conversationRootKey(root)}`;
  let result:
    | { ok: true; value: T }
    | { ok: false; error: unknown }
    | undefined;
  try {
    result = (await locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          return {
            ok: false as const,
            error: new QueuedConversationBusyError(),
          };
        }
        try {
          return { ok: true as const, value: await run() };
        } catch (error) {
          return { ok: false as const, error };
        }
      }
    )) as typeof result;
  } catch {
    throw new Error("canonical conversation lock acquisition failed");
  }
  if (!result)
    throw new Error("canonical conversation lock returned no result");
  if (!result.ok) throw result.error;
  return result.value;
}

export function resetMessageQueueRepositoryForTests(): void {
  storePromise = null;
  queueKeyPromise = null;
  mutationChain = Promise.resolve();
  fallbackStoreLock = Promise.resolve();
  legacyQueueMigrationComplete = false;
}
