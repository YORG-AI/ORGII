import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  SHARED_AUTH_PERSISTED_EVENT,
  deleteLegacyOrg2CloudAuthEnvelope,
  flushSharedServiceAuthStorage,
} from "@src/api/http/auth/sharedAuthStorage";
import { installOrg2CloudIdentityLifecycle } from "@src/features/Org2Cloud/org2CloudIdentityLifecycle";

import { identityClient } from "./identityClient";
import { isIdentityBrokerEnabled } from "./identityConfig";
import {
  readIdentitySnapshot,
  replaceIdentitySnapshot,
} from "./identitySnapshotAtom";
import {
  IdentityInvalidationSchema,
  createEmptyIdentitySnapshot,
} from "./identityTypes";
import type {
  IdentityRealm,
  IdentitySession,
  IdentitySnapshot,
} from "./identityTypes";
import { installSignInIntentLifecycle } from "./signInIntent";

export const IDENTITY_SNAPSHOT_INVALIDATED_EVENT =
  "identity://snapshot-invalidated";
const FOCUS_RESTORE_COOLDOWN_MS = 5_000;

let initializePromise: Promise<IdentitySnapshot> | null = null;
let refreshPromise: Promise<IdentitySnapshot> | null = null;
let importQueue: Promise<void> = Promise.resolve();
let lastFocusRestoreAt = 0;

async function refreshFromBroker(): Promise<IdentitySnapshot> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = identityClient
    .getSnapshot()
    .then((snapshot) => {
      replaceIdentitySnapshot(snapshot);
      return readIdentitySnapshot();
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function retryRestoreFromBroker(): Promise<IdentitySnapshot> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = identityClient
    .retryRestore()
    .then((snapshot) => {
      replaceIdentitySnapshot(snapshot);
      return readIdentitySnapshot();
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function refreshAfterFocus(): Promise<IdentitySnapshot> {
  const current = readIdentitySnapshot();
  const requiresCredentialRetry =
    current.secureStoreStatus !== "available" ||
    current.sessions.some((session) => session.status === "restoring");
  return requiresCredentialRetry
    ? retryRestoreFromBroker()
    : refreshFromBroker();
}

async function importLegacyProjectionNow(
  force: boolean
): Promise<IdentitySnapshot> {
  await flushSharedServiceAuthStorage();
  const current = readIdentitySnapshot();
  if (force || current.activeSessions.org2_cloud === undefined) {
    const outcome = await identityClient.importLegacyCloudIdentity();
    if (outcome) replaceIdentitySnapshot(outcome.snapshot);
  }
  return readIdentitySnapshot();
}

function importLegacyProjection(force = false): Promise<IdentitySnapshot> {
  const operation = importQueue.then(
    () => importLegacyProjectionNow(force),
    () => importLegacyProjectionNow(force)
  );
  importQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

async function initialize(): Promise<IdentitySnapshot> {
  installOrg2CloudIdentityLifecycle();
  installSignInIntentLifecycle();
  if (!isIdentityBrokerEnabled || !isTauri()) {
    const snapshot = createEmptyIdentitySnapshot();
    replaceIdentitySnapshot(snapshot);
    return snapshot;
  }

  try {
    await listen<unknown>(IDENTITY_SNAPSHOT_INVALIDATED_EVENT, (event) => {
      const invalidation = IdentityInvalidationSchema.safeParse(event.payload);
      if (
        !invalidation.success ||
        invalidation.data.revision <= readIdentitySnapshot().revision
      ) {
        return;
      }
      void refreshFromBroker().catch(() => {});
    });
  } catch {
    // Snapshot hydration still works when this window cannot subscribe. A
    // later focus retries the authoritative command path.
  }

  const restored = await retryRestoreFromBroker();
  try {
    await importLegacyProjection();
  } catch {
    // Shadow import failure must not hide an already-restored snapshot or
    // disturb the legacy owner. The next focus/sign-in retries it.
  }

  window.addEventListener("focus", () => {
    const now = Date.now();
    if (now - lastFocusRestoreAt < FOCUS_RESTORE_COOLDOWN_MS) return;
    lastFocusRestoreAt = now;
    void refreshAfterFocus()
      .then((snapshot) => {
        const hasBrokerIdentity =
          snapshot.activeSessions.org2_cloud !== undefined ||
          snapshot.activeSessions.hosted_service_legacy !== undefined;
        return hasBrokerIdentity ? snapshot : importLegacyProjection();
      })
      .catch(() => {});
  });
  window.addEventListener(SHARED_AUTH_PERSISTED_EVENT, () => {
    void importLegacyProjection(true).catch(() => {});
  });
  return readIdentitySnapshot().revision >= restored.revision
    ? readIdentitySnapshot()
    : restored;
}

/** Install one app-lifetime listener and hydrate before Cloud modules mount. */
export function initializeIdentityLifecycle(): Promise<IdentitySnapshot> {
  if (!initializePromise) {
    initializePromise = initialize().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

/** Re-project a newly persisted legacy login into the native Broker. */
export async function synchronizeLegacyIdentity(): Promise<IdentitySnapshot> {
  if (!isTauri()) return readIdentitySnapshot();
  return importLegacyProjection(true);
}

export async function signOutIdentity(
  realm: IdentityRealm,
  session?: Pick<IdentitySession, "sessionId">
): Promise<IdentitySnapshot> {
  // Delete the rollback envelope before the Broker generation bump. Any
  // migration already in flight may finish first, but the subsequent native
  // sign-out still wins; later focus/import events observe no legacy secret.
  if (realm === "org2_cloud") {
    await deleteLegacyOrg2CloudAuthEnvelope();
  }
  const snapshot = await identityClient.signOut(realm, session?.sessionId);
  replaceIdentitySnapshot(snapshot);
  return snapshot;
}
