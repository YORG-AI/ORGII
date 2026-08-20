import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";

const DB_NAME = "orgii-web-cloud-session-events";
const STORE_NAME = "snapshots";
const DB_VERSION = 1;

export interface WebCloudSessionEventCacheRecord {
  snapshot: CloudSessionEventSnapshot;
  storedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = run(store);
        transaction.oncomplete = () => resolve(request.result as T);
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("IndexedDB transaction failed")
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("IndexedDB transaction aborted")
          );
      })
  );
}

export async function readWebCloudSessionEventCache(
  cacheKey: string
): Promise<WebCloudSessionEventCacheRecord | null> {
  try {
    const record = await runTransaction("readonly", (store) =>
      store.get(cacheKey)
    );
    if (!record || typeof record !== "object") return null;
    const snapshot = (record as WebCloudSessionEventCacheRecord).snapshot;
    if (!snapshot || !Array.isArray(snapshot.events)) return null;
    return record as WebCloudSessionEventCacheRecord;
  } catch {
    return null;
  }
}

export async function writeWebCloudSessionEventCache(
  cacheKey: string,
  snapshot: CloudSessionEventSnapshot
): Promise<void> {
  try {
    const record: WebCloudSessionEventCacheRecord = {
      snapshot,
      storedAt: Date.now(),
    };
    await runTransaction("readwrite", (store) => store.put(record, cacheKey));
  } catch {
    // Cache is best-effort; network/manual refresh remains authoritative.
  }
}

export async function deleteWebCloudSessionEventCache(
  cacheKey: string
): Promise<void> {
  try {
    await runTransaction("readwrite", (store) => store.delete(cacheKey));
  } catch {
    // ignore
  }
}
