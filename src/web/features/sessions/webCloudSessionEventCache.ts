import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";

const DB_NAME = "orgii-web-cloud-session-events";
const STORE_NAME = "snapshots";
const STORED_AT_INDEX = "storedAt";
const DB_VERSION = 2;

export const WEB_CLOUD_SESSION_CACHE_MAX_ENTRIES = 12;
export const WEB_CLOUD_SESSION_CACHE_MAX_EVENTS = 10_000;
export const WEB_CLOUD_SESSION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

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
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME);
      if (store && !store.indexNames.contains(STORED_AT_INDEX)) {
        store.createIndex(STORED_AT_INDEX, "storedAt");
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
        transaction.oncomplete = () => {
          database.close();
          resolve(request.result as T);
        };
        transaction.onerror = () => {
          database.close();
          reject(
            transaction.error ?? new Error("IndexedDB transaction failed")
          );
        };
        transaction.onabort = () => {
          database.close();
          reject(
            transaction.error ?? new Error("IndexedDB transaction aborted")
          );
        };
      })
  );
}

export function isWebCloudSessionEventCacheRecordUsable(
  record: WebCloudSessionEventCacheRecord,
  now = Date.now()
): boolean {
  return (
    Number.isFinite(record.storedAt) &&
    now - record.storedAt <= WEB_CLOUD_SESSION_CACHE_TTL_MS &&
    Array.isArray(record.snapshot?.events) &&
    record.snapshot.events.length <= WEB_CLOUD_SESSION_CACHE_MAX_EVENTS
  );
}

export function webCloudSessionCacheOverflowCount(entryCount: number): number {
  return Math.max(0, entryCount - WEB_CLOUD_SESSION_CACHE_MAX_ENTRIES);
}

async function writeBoundedRecord(
  cacheKey: string,
  record: WebCloudSessionEventCacheRecord
): Promise<void> {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(record, cacheKey);

    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let entriesToDelete = webCloudSessionCacheOverflowCount(
        countRequest.result
      );
      if (entriesToDelete <= 0) return;
      const cursorRequest = store
        .index(STORED_AT_INDEX)
        .openKeyCursor(null, "next");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || entriesToDelete <= 0) return;
        store.delete(cursor.primaryKey);
        entriesToDelete -= 1;
        cursor.continue();
      };
    };

    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

export async function readWebCloudSessionEventCache(
  cacheKey: string
): Promise<WebCloudSessionEventCacheRecord | null> {
  try {
    const record = await runTransaction("readonly", (store) =>
      store.get(cacheKey)
    );
    if (!record || typeof record !== "object") return null;
    const candidate = record as WebCloudSessionEventCacheRecord;
    if (!isWebCloudSessionEventCacheRecordUsable(candidate)) {
      await deleteWebCloudSessionEventCache(cacheKey);
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export async function writeWebCloudSessionEventCache(
  cacheKey: string,
  snapshot: CloudSessionEventSnapshot
): Promise<void> {
  try {
    if (snapshot.events.length > WEB_CLOUD_SESSION_CACHE_MAX_EVENTS) {
      await deleteWebCloudSessionEventCache(cacheKey);
      return;
    }
    const record: WebCloudSessionEventCacheRecord = {
      snapshot,
      storedAt: Date.now(),
    };
    await writeBoundedRecord(cacheKey, record);
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

/** Remove every transcript snapshot owned by the current browser profile. */
export async function clearWebCloudSessionEventCache(): Promise<void> {
  try {
    await runTransaction("readwrite", (store) => store.clear());
  } catch {
    // Cache is best-effort and auth state is cleared synchronously by callers.
  }
}
