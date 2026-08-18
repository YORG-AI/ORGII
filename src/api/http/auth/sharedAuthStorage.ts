import { isTauri } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * Auth storage shared by every WebView origin that uses the primary ORG2
 * Tauri identifier. Tauri dev and the bundled app have different origins, so
 * browser localStorage cannot be the source of truth for their login session.
 *
 * Secondary app identifiers still get their own Tauri app-data directory and
 * therefore remain isolated from the primary identity.
 */
const SHARED_AUTH_STORE_PATH = "shared-service-auth.json";
const SHARED_AUTH_SCHEMA_KEY = "__orgii_shared_auth_schema";
const SHARED_AUTH_SCHEMA_VERSION = 3;

export const SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY = "orgii:org2-cloud-v1:auth";
export const SHARED_AUTH_PERSISTED_EVENT =
  "orgii:shared-service-auth-persisted";

const RETIRED_HOSTED_AUTH_KEYS = [
  "orgii.supabase.auth",
  "orgii.supabase.auth-code-verifier",
  "hosted_access_token",
  "hosted_refresh_token",
  "hosted_token_expiry",
  "hosted_user_id",
  "hosted_processed_code",
  "id_token",
  "user_id",
  "orgii-user-info",
] as const;

const MIRRORED_AUTH_KEYS = [SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY] as const;

type SharedAuthKey = (typeof MIRRORED_AUTH_KEYS)[number];

interface StringStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

let store: LazyStore | null = null;
let operationQueue: Promise<void> = Promise.resolve();
let initializePromise: Promise<void> | null = null;
let legacyCloudCleanupPromise: Promise<void> | null = null;

function localValue(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(key);
}

function setLocalValue(key: string, value: string | undefined): void {
  if (typeof localStorage === "undefined") return;
  if (value === undefined) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

function getStore(): LazyStore {
  store ??= new LazyStore(SHARED_AUTH_STORE_PATH, {
    defaults: {},
    autoSave: false,
  });
  return store;
}

function enqueueStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function reloadStore(sharedStore: LazyStore): Promise<void> {
  await sharedStore.init();
  await sharedStore.reload({ ignoreDefaults: true });
}

async function readStoreSnapshot(
  sharedStore: LazyStore
): Promise<Map<string, unknown>> {
  return new Map(await sharedStore.entries<unknown>());
}

async function migrateLocalAuthOnce(
  sharedStore: LazyStore,
  snapshot: Map<string, unknown>
): Promise<void> {
  let retiredHostedAuthDeleted = false;
  for (const key of RETIRED_HOSTED_AUTH_KEYS) {
    setLocalValue(key, undefined);
    if (snapshot.has(key)) {
      await sharedStore.delete(key);
      snapshot.delete(key);
      retiredHostedAuthDeleted = true;
    }
  }

  const schemaVersion = snapshot.get(SHARED_AUTH_SCHEMA_KEY);
  if (schemaVersion === SHARED_AUTH_SCHEMA_VERSION) {
    if (retiredHostedAuthDeleted) await sharedStore.save();
    return;
  }

  const localEntries: Array<[SharedAuthKey, string]> = [];
  let sharedAuthAlreadyExists = false;

  for (const key of MIRRORED_AUTH_KEYS) {
    const sharedValue = snapshot.get(key);
    sharedAuthAlreadyExists ||= typeof sharedValue === "string";

    const value = localValue(key);
    if (value !== null) {
      localEntries.push([key, value]);
    }
  }

  const storeWasPreviouslyEstablished =
    typeof schemaVersion === "number" || sharedAuthAlreadyExists;

  // The very first origin seeds its existing hosted-auth values. Do not let
  // an empty dev origin establish an authoritative store: the bundled origin
  // may still own the pre-upgrade login.
  if (!storeWasPreviouslyEstablished && localEntries.length === 0) {
    if (retiredHostedAuthDeleted) await sharedStore.save();
    return;
  }

  if (!storeWasPreviouslyEstablished) {
    for (const [key, value] of localEntries) {
      await sharedStore.set(key, value);
      snapshot.set(key, value);
    }
  }

  // Schema v1 predated ORG2 Cloud auth. Keep its migration unresolved while
  // both the shared store and this origin lack that key, so the bundled
  // `tauri://localhost` origin can still contribute it on a later launch.
  const sharedCloudAuth = snapshot.get(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY);
  const localCloudAuth = localValue(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY);
  if (typeof sharedCloudAuth !== "string" && localCloudAuth !== null) {
    await sharedStore.set(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY, localCloudAuth);
    snapshot.set(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY, localCloudAuth);
  }

  const cloudMigrationEstablished =
    typeof snapshot.get(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY) === "string";
  const cloudMigrationPreviouslyCompleted =
    typeof schemaVersion === "number" && schemaVersion >= 2;
  const nextSchemaVersion =
    cloudMigrationEstablished || cloudMigrationPreviouslyCompleted ? 3 : 1;
  if (schemaVersion === nextSchemaVersion) {
    if (retiredHostedAuthDeleted) await sharedStore.save();
    return;
  }

  await sharedStore.set(SHARED_AUTH_SCHEMA_KEY, nextSchemaVersion);
  snapshot.set(SHARED_AUTH_SCHEMA_KEY, nextSchemaVersion);
  await sharedStore.save();
}

function copySharedAuthToLocal(snapshot: ReadonlyMap<string, unknown>): void {
  for (const key of MIRRORED_AUTH_KEYS) {
    const value = snapshot.get(key);
    setLocalValue(key, typeof value === "string" ? value : undefined);
  }
}

function notifySharedAuthPersisted(key: SharedAuthKey): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SHARED_AUTH_PERSISTED_EVENT, { detail: { key } })
  );
}

async function initializeOrSynchronize(): Promise<void> {
  if (!isTauri()) return;

  await enqueueStoreOperation(async () => {
    const sharedStore = getStore();
    await reloadStore(sharedStore);
    const snapshot = await readStoreSnapshot(sharedStore);
    await migrateLocalAuthOnce(sharedStore, snapshot);
    copySharedAuthToLocal(snapshot);
  });
}

/**
 * Establishes the shared store as the source of truth before auth atoms and
 * route guards are imported. The first upgraded launch migrates the current
 * origin's existing auth state; later launches never resurrect stale
 * per-origin localStorage after a shared sign-out.
 */
export function initializeSharedServiceAuthStorage(): Promise<void> {
  initializePromise ??= initializeOrSynchronize();
  return initializePromise;
}

/** Migration-only storage for the pre-PKCE Cloud envelope. */
const legacyCloudAuthStorage: StringStorage = {
  async getItem(key) {
    if (!isTauri()) return localValue(key);

    return enqueueStoreOperation(async () => {
      const sharedStore = getStore();
      await reloadStore(sharedStore);
      const value = await sharedStore.get<unknown>(key);
      return typeof value === "string" ? value : null;
    });
  },

  async setItem(key, value) {
    if (!isTauri()) {
      setLocalValue(key, value);
      return;
    }

    await enqueueStoreOperation(async () => {
      const sharedStore = getStore();
      await reloadStore(sharedStore);
      const snapshot = await readStoreSnapshot(sharedStore);
      await migrateLocalAuthOnce(sharedStore, snapshot);
      await sharedStore.set(key, value);
      await sharedStore.save();
    });
  },

  async removeItem(key) {
    if (!isTauri()) {
      setLocalValue(key, undefined);
      return;
    }

    await enqueueStoreOperation(async () => {
      const sharedStore = getStore();
      await reloadStore(sharedStore);
      const snapshot = await readStoreSnapshot(sharedStore);
      await migrateLocalAuthOnce(sharedStore, snapshot);
      await sharedStore.delete(key);
      await sharedStore.save();
    });
  },
};

/**
 * Synchronous auth helpers keep their current localStorage API and mirror
 * mutations to the shared Tauri store in invocation order.
 */
function mirrorLegacyCloudAuthValue(
  key: SharedAuthKey,
  value: string | null
): void {
  if (!isTauri()) return;
  const operation =
    value === null
      ? legacyCloudAuthStorage.removeItem(key)
      : legacyCloudAuthStorage.setItem(key, value);
  void Promise.resolve(operation)
    .then(() => notifySharedAuthPersisted(key))
    .catch(() => {});
}

/**
 * Wait until every shared-store mutation queued before this call has reached
 * disk. Identity migration uses this handoff after the legacy atom changes so
 * the native Broker never races an older store snapshot.
 */
export function flushSharedServiceAuthStorage(): Promise<void> {
  return operationQueue;
}

/**
 * Delete the pre-Broker Cloud credential envelope after the Broker has
 * successfully refreshed and verified it. This is the migration commit
 * point: failures before this call leave the legacy owner available for a
 * safe retry, while success prevents it from taking ownership back.
 */
export async function deleteLegacyOrg2CloudAuthEnvelope(): Promise<void> {
  if (legacyCloudCleanupPromise) return legacyCloudCleanupPromise;
  legacyCloudCleanupPromise = (async () => {
    setLocalValue(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY, undefined);
    if (isTauri()) {
      await legacyCloudAuthStorage.removeItem(
        SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY
      );
    }
    notifySharedAuthPersisted(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY);
  })().catch((error) => {
    legacyCloudCleanupPromise = null;
    throw error;
  });
  return legacyCloudCleanupPromise;
}

/** Write the old callback envelope only long enough for native migration. */
export function stageLegacyOrg2CloudAuthEnvelope(serialized: string): void {
  legacyCloudCleanupPromise = null;
  setLocalValue(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY, serialized);
  mirrorLegacyCloudAuthValue(SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY, serialized);
}

export const __SHARED_AUTH_STORAGE_INTERNALS = {
  MIRRORED_AUTH_KEYS,
  SHARED_AUTH_SCHEMA_KEY,
  SHARED_AUTH_SCHEMA_VERSION,
  SHARED_AUTH_STORE_PATH,
  RETIRED_HOSTED_AUTH_KEYS,
};
