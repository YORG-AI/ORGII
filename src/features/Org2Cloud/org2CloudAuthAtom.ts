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
import { z } from "zod/v4";

import {
  SHARED_AUTH_SYNCHRONIZED_EVENT,
  SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY,
  mirrorSharedServiceAuthValue,
} from "@src/api/http/auth/sharedAuthStorage";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

export const ORG2_CLOUD_AUTH_STORAGE_KEY = SHARED_ORG2_CLOUD_AUTH_STORAGE_KEY;

export const Org2CloudProfileSchema = z.object({
  displayName: z.string().optional(),
  primaryEmail: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type Org2CloudProfile = z.infer<typeof Org2CloudProfileSchema>;

export const Org2CloudAuthStateSchema = z.object({
  kind: z.literal("org2_cloud"),
  supabaseUrl: z.string(),
  supabaseAnonKey: z.string(),
  userId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token expiry, unix epoch seconds (wire format, see header). */
  expiresAt: z.number(),
  profile: Org2CloudProfileSchema.optional(),
});

export type Org2CloudAuthState = z.infer<typeof Org2CloudAuthStateSchema>;

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

/** Parse the exact serialized representation stored by the auth atom. */
export function parseStoredOrg2CloudAuth(
  raw: string | null
): Org2CloudAuthState | null {
  if (raw === null) return null;
  return StoredAuthSchema.parse(JSON.parse(raw));
}

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
 * Write a refreshed session back to the auth atom under a COMPARE-AND-SET:
 * a `ensureFreshSession` round-trip can resolve AFTER the user signed out
 * or switched endpoints mid-flight (both wipe/replace the atom). A blind
 * `set(fresh)` would then resurrect a discarded session — re-persisting
 * old-backend tokens into localStorage and flipping the UI back to
 * signed-in. Only commit when the atom is still exactly the session we
 * refreshed. `setAuth` must accept jotai's functional-updater form (both
 * `store.set` and the `useAtom`/`useSetAtom` setter do).
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
    if (current !== previous) return current;
    committed = true;
    return fresh;
  });
  return committed;
}
