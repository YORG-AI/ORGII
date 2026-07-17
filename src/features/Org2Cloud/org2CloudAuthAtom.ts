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

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

export const ORG2_CLOUD_AUTH_STORAGE_KEY = "orgii:org2-cloud-v1:auth";

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

const StoredAuthSchema = Org2CloudAuthStateSchema.nullable();

export const org2CloudAuthAtom = atomWithStorage<Org2CloudAuthState | null>(
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  null,
  createZodJsonStorage(StoredAuthSchema),
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
