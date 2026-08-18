/**
 * Turn a parsed `orgii://auth/callback` payload into persisted auth state.
 *
 * Plain TS (no React) so the deep-link handler can call it from both the
 * live `onOpenUrl` listener and the cold-start `getCurrent` path with a
 * jotai setter. Profile enrichment is fire-and-forget: sign-in succeeds even
 * when the profile RPC is unreachable.
 */
import { getDefaultStore } from "jotai";

import { stageLegacyOrg2CloudAuthEnvelope } from "@src/api/http/auth/sharedAuthStorage";
import Message from "@src/components/Message";
import { synchronizeLegacyIdentity } from "@src/features/Identity/identityLifecycle";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import { type Org2CloudAuthCallback, decodeJwtSub } from "./authCallback";
import { getCloudEndpoint } from "./config";
import {
  type LegacyOrg2CloudAuthState,
  type Org2CloudAuthState,
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";
import { ensureFreshSession, getCloudProfile } from "./org2CloudClient";

const log = createLogger("Org2CloudAuth");

export type SetOrg2CloudAuth = (
  update:
    | Org2CloudAuthState
    | null
    | ((prev: Org2CloudAuthState | null) => Org2CloudAuthState | null)
) => void;

/**
 * Persist the signed-in state, toast success, then asynchronously enrich the
 * atom with the cloud profile. Returns `false` when the access token carries
 * no usable `sub` claim (nothing is persisted in that case).
 */
export function completeOrg2CloudSignIn(
  callback: Org2CloudAuthCallback,
  setAuth: SetOrg2CloudAuth
): boolean {
  const userId = decodeJwtSub(callback.accessToken);
  if (!userId) {
    log.warn("auth callback access token has no sub claim; ignoring");
    return false;
  }

  // Snapshot the ACTIVE endpoint (official or custom) into the auth state —
  // the tokens are only valid against the GoTrue that issued them.
  const endpoint = getCloudEndpoint();
  const legacy: LegacyOrg2CloudAuthState = {
    kind: "org2_cloud",
    supabaseUrl: endpoint.supabaseUrl,
    supabaseAnonKey: endpoint.anonKey,
    userId,
    accessToken: callback.accessToken,
    refreshToken: callback.refreshToken,
    expiresAt: callback.expiresAt,
  };
  stageLegacyOrg2CloudAuthEnvelope(JSON.stringify(legacy));
  void synchronizeLegacyIdentity()
    .then(() => {
      const projection = getDefaultStore().get(org2CloudAuthAtom);
      if (projection) return enrichOrg2CloudProfile(projection, setAuth);
    })
    .catch((error: unknown) => {
      log.warn("could not project Cloud login into the identity Broker", error);
    });
  Message.success(i18n.t("navigation:cloud.signedInToast"));
  return true;
}

/**
 * Fetch the cloud profile and merge it into the persisted auth state.
 * Exported for the app-start retry path (`useOrg2CloudOrgs`): enrichment at
 * sign-in is fire-and-forget, so a transient failure (or a missing profiles
 * row right after a backend reset) would otherwise leave the UI showing the
 * raw user id forever.
 */
export async function enrichOrg2CloudProfile(
  state: Org2CloudAuthState,
  setAuth: SetOrg2CloudAuth
): Promise<void> {
  // The callback token is usually fresh, but expires_at is server-decided —
  // refresh first when it is already within the expiry skew (Phase 2 rule:
  // check before every getCloudProfile call; no background timers).
  const fresh = await ensureFreshSession(state);
  if (!fresh) {
    log.warn("session refresh failed during profile enrichment");
    return;
  }
  if (!commitRefreshedAuth(setAuth, state, fresh)) return;

  // Verify the same object is still current even when no refresh was needed.
  // Endpoint switches and sign-out replace the object synchronously.
  let isCurrent = false;
  setAuth((prev) => {
    isCurrent =
      prev?.sessionId === state.sessionId &&
      prev.generation === state.generation;
    return prev;
  });
  if (!isCurrent) return;

  const profile = await getCloudProfile(fresh.accessToken, {
    supabaseUrl: fresh.supabaseUrl,
    anonKey: fresh.supabaseAnonKey,
  });
  if (!profile) return;
  setAuth((prev) => {
    // Only enrich the session we just created — the user may have signed
    // out (or re-signed-in as someone else) while the RPC was in flight.
    if (
      prev?.sessionId !== state.sessionId ||
      prev.generation !== state.generation
    ) {
      return prev;
    }
    return {
      ...prev,
      profile: {
        displayName: profile.displayName,
        primaryEmail: profile.primaryEmail,
        avatarUrl: profile.avatarUrl,
      },
    };
  });
}
