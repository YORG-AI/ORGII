/**
 * Non-secret renderer projection of the native identity Broker.
 *
 * Access credentials are returned only as short-lived action leases and are
 * never written into Jotai storage, localStorage, or the shared Tauri store.
 * The legacy schema remains here solely so old clients can be imported once
 * into the Broker during the compatibility window.
 */
import { atom, getDefaultStore } from "jotai";
import { z } from "zod/v4";

import {
  readIdentitySnapshot,
  subscribeIdentitySnapshotChanges,
} from "@src/features/Identity/identitySnapshotAtom";
import {
  type IdentitySnapshot,
  getActiveIdentitySession,
} from "@src/features/Identity/identityTypes";

export const Org2CloudProfileSchema = z.object({
  displayName: z.string().optional(),
  primaryEmail: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type Org2CloudProfile = z.infer<typeof Org2CloudProfileSchema>;

export const Org2CloudAuthStateSchema = z
  .object({
    kind: z.literal("org2_cloud"),
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
    supabaseUrl: z.url(),
    userId: z.string().min(1),
    profile: Org2CloudProfileSchema.optional(),
  })
  .strict();

export type Org2CloudAuthState = z.infer<typeof Org2CloudAuthStateSchema>;

/** Transient request context returned by the Broker access-lease command. */
export type Org2CloudRequestAuth = Org2CloudAuthState & {
  supabaseAnonKey: string;
  accessToken: string;
  expiresAt: number;
};

export const LegacyOrg2CloudAuthStateSchema = z
  .object({
    kind: z.literal("org2_cloud"),
    supabaseUrl: z.string(),
    supabaseAnonKey: z.string(),
    userId: z.string(),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    profile: Org2CloudProfileSchema.optional(),
  })
  .strict();

export type LegacyOrg2CloudAuthState = z.infer<
  typeof LegacyOrg2CloudAuthStateSchema
>;

/** Parse only the pre-Broker persisted envelope for one-time migration. */
export function parseStoredOrg2CloudAuth(
  raw: string | null
): LegacyOrg2CloudAuthState | null {
  if (raw === null) return null;
  return LegacyOrg2CloudAuthStateSchema.nullable().parse(JSON.parse(raw));
}

export function org2CloudAuthIdentityKey(
  auth: Pick<Org2CloudAuthState, "supabaseUrl" | "userId">
): string {
  return `${auth.supabaseUrl.trim().replace(/\/+$/, "")}|${auth.userId}`;
}

function profileFromSnapshot(
  snapshot: IdentitySnapshot,
  previous: Org2CloudAuthState | null
): Org2CloudAuthState | null {
  const session = getActiveIdentitySession(snapshot, "org2_cloud");
  if (!session || session.status === "reauth_required") return null;
  const sameSession =
    previous?.sessionId === session.sessionId &&
    previous.generation === session.generation;
  const previousProfile = sameSession ? previous.profile : undefined;
  const profile: Org2CloudProfile = {
    displayName:
      previousProfile?.displayName ?? session.displayName ?? undefined,
    primaryEmail:
      previousProfile?.primaryEmail ?? session.primaryEmail ?? undefined,
    avatarUrl: previousProfile?.avatarUrl ?? session.avatarUrl ?? undefined,
  };
  return {
    kind: "org2_cloud",
    sessionId: session.sessionId,
    generation: session.generation,
    supabaseUrl: session.issuer.replace(/\/+$/, ""),
    userId: session.subject,
    profile:
      profile.displayName || profile.primaryEmail || profile.avatarUrl
        ? profile
        : undefined,
  };
}

const store = getDefaultStore();
const initialAuth = profileFromSnapshot(readIdentitySnapshot(), null);
export const org2CloudAuthAtom = atom<Org2CloudAuthState | null>(initialAuth);
org2CloudAuthAtom.debugLabel = "org2CloudAuthAtom";

subscribeIdentitySnapshotChanges((snapshot) => {
  const current = store.get(org2CloudAuthAtom);
  store.set(org2CloudAuthAtom, profileFromSnapshot(snapshot, current));
});

function isSameSession(
  current: Org2CloudAuthState | null,
  expected: Org2CloudAuthState
): boolean {
  return (
    current?.sessionId === expected.sessionId &&
    current.generation === expected.generation &&
    current.userId === expected.userId &&
    current.supabaseUrl === expected.supabaseUrl
  );
}

/**
 * Compatibility guard for call sites that used to persist rotated tokens.
 * A lease is intentionally never written; this only proves the projection is
 * still the session that initiated the request.
 */
export function commitRefreshedAuth(
  setAuth: (
    updater: (prev: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ) => void,
  previous: Org2CloudAuthState,
  _fresh: Org2CloudRequestAuth
): boolean {
  let currentSession = false;
  setAuth((current) => {
    currentSession = isSameSession(current, previous);
    return current;
  });
  return currentSession;
}

/** Clear only the rejected Broker generation; a newer login is preserved. */
export function clearRejectedAuth(
  setAuth: (
    updater: (prev: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ) => void,
  rejected: Org2CloudAuthState
): boolean {
  let cleared = false;
  setAuth((current) => {
    if (!isSameSession(current, rejected)) return current;
    cleared = true;
    return null;
  });
  return cleared;
}
