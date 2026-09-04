/**
 * Persisted ORG2 Cloud auth state (design §8.2 Org2CloudAuthState).
 *
 * `null` = signed out. Persisted via the same zod-validated localStorage
 * idiom as the collab atoms (`createZodJsonStorage`): a corrupted or
 * schema-incompatible stored value parses to the initial value (`null`,
 * i.e. signed out) instead of crashing atom hydration.
 *
 * `expiresAt` is kept as UNIX EPOCH SECONDS (number) — the exact wire
 * representation of both the deep-link fragment (`expires_at`) and the
 * Supabase token-refresh response, so no conversion can drift. Compare with
 * `Date.now() / 1000`.
 */
import { atomWithStorage } from "jotai/utils";

import {
  SHARED_AUTH_SYNCHRONIZED_EVENT,
  SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY,
  mirrorSharedServiceAuthValue,
} from "@src/api/http/auth/sharedAuthStorage";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  type Org2CloudAuthState,
  Org2CloudAuthStateSchema,
  type Org2CloudProfile,
  Org2CloudProfileSchema,
  parseStoredOrg2CloudAuth,
} from "./org2CloudAuthState";

export { Org2CloudAuthStateSchema, Org2CloudProfileSchema };
export type { Org2CloudAuthState, Org2CloudProfile };

export const ORG2_CLOUD_AUTH_STORAGE_KEY = SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY;

/**
 * Stable privacy/cache boundary for managed-cloud state. Access-token refresh
 * and profile enrichment replace the auth object without changing identity;
 * endpoint or account switches must produce a different key.
 */
export function org2CloudAuthIdentityKey(
  auth: Pick<Org2CloudAuthState, "supabaseUrl" | "userId">
): string {
  return `${auth.supabaseUrl.trim().replace(/\/+$/, "")}|${auth.userId}`;
}

const StoredAuthSchema = Org2CloudAuthStateSchema.nullable();
const localOrg2CloudAuthStorage = createZodJsonStorage(StoredAuthSchema);

export { parseStoredOrg2CloudAuth };

const sharedOrg2CloudAuthStorage = {
  getItem(key: string, initialValue: Org2CloudAuthState | null) {
    return localOrg2CloudAuthStorage.getItem(key, initialValue);
  },
  setItem(key: string, value: Org2CloudAuthState | null) {
    localOrg2CloudAuthStorage.setItem(key, value);
    mirrorSharedServiceAuthValue(
      ORG2_CLOUD_AUTH_STORAGE_KEY,
      JSON.stringify(value)
    );
  },
  removeItem(key: string) {
    localOrg2CloudAuthStorage.removeItem(key);
    mirrorSharedServiceAuthValue(ORG2_CLOUD_AUTH_STORAGE_KEY, null);
  },
  subscribe(
    key: string,
    callback: (value: Org2CloudAuthState | null) => void,
    initialValue: Org2CloudAuthState | null
  ) {
    const handleSynchronized = () => {
      callback(localOrg2CloudAuthStorage.getItem(key, initialValue));
    };
    window.addEventListener(SHARED_AUTH_SYNCHRONIZED_EVENT, handleSynchronized);
    return () =>
      window.removeEventListener(
        SHARED_AUTH_SYNCHRONIZED_EVENT,
        handleSynchronized
      );
  },
};

export const org2CloudAuthAtom = atomWithStorage<Org2CloudAuthState | null>(
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  null,
  sharedOrg2CloudAuthStorage,
  { getOnInit: true }
);
org2CloudAuthAtom.debugLabel = "org2CloudAuthAtom";

/**
 * Compare the persisted generation of a cloud session.
 *
 * Object identity cannot be used here: storage hydration parses the same
 * JSON into a new object. The endpoint/account pair identifies who is signed
 * in, while the refresh token is the session generation and changes after a
 * successful rotation. This lets async work survive harmless hydration but
 * rejects writes from a signed-out, switched, or already-rotated session.
 */
export function isSameOrg2CloudSession(
  current: Org2CloudAuthState | null,
  expected: Org2CloudAuthState
): current is Org2CloudAuthState {
  return (
    current !== null &&
    org2CloudAuthIdentityKey(current) === org2CloudAuthIdentityKey(expected) &&
    current.refreshToken === expected.refreshToken
  );
}

/**
 * Write a refreshed session back to the auth atom under a COMPARE-AND-SET:
 * a `ensureFreshSession` round-trip can resolve AFTER the user signed out
 * or switched endpoints mid-flight (both wipe/replace the atom). A blind
 * `set(fresh)` would then resurrect a discarded session — re-persisting
 * old-backend tokens into localStorage and flipping the UI back to
 * signed-in. Only commit when the atom still contains the same persisted
 * session generation. `setAuth` must accept jotai's functional-updater form
 * (both `store.set` and the `useAtom`/`useSetAtom` setter do).
 */
export function commitRefreshedAuth(
  setAuth: (
    updater: (prev: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ) => void,
  previous: Org2CloudAuthState,
  fresh: Org2CloudAuthState
): boolean {
  if (fresh === previous) return true;
  let committed = false;
  setAuth((current) => {
    if (!isSameOrg2CloudSession(current, previous)) return current;
    committed = true;
    return fresh;
  });
  return committed;
}

/**
 * Sign the user out locally after GoTrue DEFINITIVELY rejects a refresh
 * credential (400/401 `invalid_grant` — never a transient network/timeout
 * failure, see `ensureFreshSession`'s `onRefreshRejected`). Guarded by a
 * compare-and-set, but deliberately on STABLE IDENTITY (`userId` +
 * `refreshToken`) rather than object reference.
 *
 * Reference equality is NOT safe here: `org2CloudAuthAtom` is an
 * `atomWithStorage` with `{ getOnInit: true }`, whose `onMount` re-reads
 * `storage.getItem(...)` and calls `setAtom(...)` on every mount (jotai's
 * `atomWithStorage` idiom — see `node_modules/jotai/.../utils.mjs`). Because
 * `createZodJsonStorage`'s `getItem` runs `JSON.parse` + `schema.parse` on
 * every call, it returns a BRAND-NEW object each time even when the
 * persisted bytes are byte-for-byte unchanged. A `current` snapshot
 * captured just before that re-hydration settles is therefore never
 * `===` the atom's live value again, even though it is the exact same
 * session — so a reference-equality CAS silently never fires and the
 * rejected session is never cleared (the reported zombie-signed-in bug).
 * Comparing `userId`/`refreshToken` survives that re-hydration while still
 * refusing to clobber a newer sign-in or a concurrently rotated token
 * (different `userId` and/or `refreshToken`).
 */
export function clearRejectedAuth(
  setAuth: (
    updater: (prev: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ) => void,
  rejected: Org2CloudAuthState
): boolean {
  let cleared = false;
  setAuth((current) => {
    if (
      !current ||
      current.userId !== rejected.userId ||
      current.refreshToken !== rejected.refreshToken
    ) {
      return current;
    }
    cleared = true;
    return null;
  });
  return cleared;
}
