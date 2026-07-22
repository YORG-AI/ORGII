/**
 * Raw-fetch client for the managed ORG2 Cloud Supabase project (design §8).
 *
 * Deliberately NO supabase-js. Cloud RPCs
 * live in the `org2_cloud` PostgREST schema, so every /rest/v1 request
 * carries `Content-Profile: org2_cloud` in addition to the anon `apikey`.
 * The token-refresh endpoint is GoTrue (`/auth/v1/token`), which takes only
 * the apikey header.
 *
 * All failures degrade to `null` returns with a logged warning — Phase 2
 * callers treat cloud reachability as best-effort enrichment.
 */
import { z } from "zod/v4";

import { createLogger } from "@src/hooks/logger";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { CollabSessionAccessMode } from "@src/store/collaboration/types";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import type { Org2CloudAuthState, Org2CloudProfile } from "./org2CloudAuthAtom";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";
import { CLOUD_ORG_ROLES, type CloudOrgRole } from "./org2CloudOrgManagement";

const log = createLogger("Org2CloudClient");

/** Refresh when the access token expires within this many seconds. */
const REFRESH_SKEW_SECONDS = 60;

const CloudProfileWireSchema = z.object({
  userId: z.string().optional(),
  displayName: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  primaryEmail: z.string().nullish(),
  createdAt: z.string().nullish(),
});

export interface CloudProfile {
  userId?: string;
  displayName?: string;
  primaryEmail?: string;
  avatarUrl?: string;
}

const RefreshResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
});

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch seconds (Supabase wire format). */
  expiresAt: number;
}

interface RefreshAttemptResult {
  tokens: RefreshedTokens | null;
  /** GoTrue explicitly rejected the refresh credential (400/401). */
  permanentlyRejected: boolean;
}

let inFlightRefresh:
  | { key: string; promise: Promise<RefreshAttemptResult> }
  | undefined;

type CloudRpcEndpoint = Pick<
  ReturnType<typeof getCloudEndpoint>,
  "supabaseUrl" | "anonKey"
>;

function rpcUrl(
  functionName: string,
  endpoint: CloudRpcEndpoint = getCloudEndpoint()
): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

function rpcHeaders(
  accessToken?: string,
  endpoint: CloudRpcEndpoint = getCloudEndpoint()
): Record<string, string> {
  const { anonKey } = endpoint;
  return {
    apikey: anonKey,
    authorization: `Bearer ${accessToken ?? anonKey}`,
    "content-type": "application/json",
    "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
  };
}

async function callRpc(
  functionName: string,
  accessToken?: string,
  body?: Record<string, unknown>,
  endpoint: CloudRpcEndpoint = getCloudEndpoint()
): Promise<unknown | null> {
  try {
    const response = await fetchWithTransportRetry(
      rpcUrl(functionName, endpoint),
      {
        method: "POST",
        headers: rpcHeaders(accessToken, endpoint),
        body: JSON.stringify(body ?? {}),
      }
    );
    if (!response.ok) {
      log.warn(`rpc ${functionName} failed with status ${response.status}`);
      return null;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    log.warn(`rpc ${functionName} request error:`, error);
    return null;
  }
}

/** Anon-callable cloud schema version probe. `null` on any failure. */
export async function schemaVersion(): Promise<number | null> {
  const payload = await callRpc("schema_version");
  return typeof payload === "number" ? payload : null;
}

/**
 * Fetch the signed-in user's cloud profile. Returns `null` on any failure
 * or when the server returns an empty object (no profile row yet).
 */
export async function getCloudProfile(
  accessToken: string,
  endpoint?: CloudRpcEndpoint
): Promise<CloudProfile | null> {
  const payload = await callRpc(
    "get_cloud_profile",
    accessToken,
    undefined,
    endpoint
  );
  const parsed = CloudProfileWireSchema.safeParse(payload);
  if (!parsed.success) {
    if (payload !== null) {
      log.warn("get_cloud_profile returned unexpected shape");
    }
    return null;
  }
  const { userId, displayName, avatarUrl, primaryEmail } = parsed.data;
  if (!userId) return null; // {} — no profile yet
  return {
    userId,
    displayName: displayName ?? undefined,
    avatarUrl: avatarUrl ?? undefined,
    primaryEmail: primaryEmail ?? undefined,
  };
}

const CloudOrgWireSchema = z.object({
  orgId: z.string(),
  name: z.string(),
  role: z.enum(CLOUD_ORG_ROLES),
});

export interface CloudOrg {
  orgId: string;
  name: string;
  role: CloudOrgRole;
}

const CloudOrgMemberWireSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullish(),
  role: z.enum(CLOUD_ORG_ROLES),
  status: z.string(),
  joinedAt: z.string().nullish(),
  // Per-member sharing floor (admin-set MINIMUM for this member; 'off' = no
  // member-level requirement — the org-wide floor still applies). Absent on
  // pre-floor backends ⇒ 'off'; unrecognized values degrade to 'off' too.
  sharingFloor: z
    .enum([
      COLLAB_SESSION_ACCESS_MODE.OFF,
      COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
      COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
    ])
    .nullish()
    .catch(undefined),
});

export interface CloudOrgMember {
  userId: string;
  displayName?: string;
  role: CloudOrgRole;
  status: string;
  joinedAt?: string;
  /** Member-level sharing floor; absent/'off' ⇒ no member requirement. */
  sharingFloor?: CollabSessionAccessMode;
}

const EntitlementStateWireSchema = z.object({
  plan: z.string(),
  status: z.string(),
  replayRetentionDays: z.number().nullish(),
  maxOrgMembers: z.number().nullish(),
  sessionSyncEnabled: z.boolean().nullish(),
  // Admin-set org sharing FLOOR (0002): the minimum access mode a member may
  // share a session at. Absent on pre-0002 backends ⇒ treat as 'off' (no
  // floor). An unrecognized value is dropped by the enum, degrading to 'off'.
  orgSharingFloor: z
    .enum([
      COLLAB_SESSION_ACCESS_MODE.OFF,
      COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
      COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
    ])
    .nullish()
    .catch(undefined),
});

export interface CloudEntitlementState {
  plan: string;
  status: string;
  replayRetentionDays?: number;
  maxOrgMembers?: number;
  sessionSyncEnabled?: boolean;
  /** Org sharing floor; `undefined` (absent on the wire) ⇒ 'off' / no floor. */
  orgSharingFloor?: CollabSessionAccessMode;
}

/**
 * Cloud orgs the signed-in user belongs to (`list_my_orgs`). Returns `null`
 * on any failure (offline / unreachable / wire drift) and `[]` only when the
 * server authoritatively reports no memberships — so a membership-gated
 * caller can tell "roster not yet known" apart from "no orgs" (same
 * null-on-failure idiom as `getCloudProfile` / `getEntitlementState`).
 * Callers that only need the list treat `null` as `[]`.
 */
export async function listMyOrgs(
  accessToken: string
): Promise<CloudOrg[] | null> {
  const payload = await callRpc("list_my_orgs", accessToken);
  const parsed = z.array(CloudOrgWireSchema).safeParse(payload);
  if (!parsed.success) {
    if (payload !== null) {
      log.warn("list_my_orgs returned unexpected shape");
    }
    return null;
  }
  return parsed.data;
}

/** Members of a cloud org (`list_org_members`). `[]` on any failure. */
export async function listOrgMembers(
  accessToken: string,
  orgId: string
): Promise<CloudOrgMember[]> {
  const payload = await callRpc("list_org_members", accessToken, {
    p_org_id: orgId,
  });
  const parsed = z.array(CloudOrgMemberWireSchema).safeParse(payload);
  if (!parsed.success) {
    if (payload !== null) {
      log.warn("list_org_members returned unexpected shape");
    }
    return [];
  }
  return parsed.data.map(
    ({ userId, displayName, role, status, joinedAt, sharingFloor }) => ({
      userId,
      displayName: displayName ?? undefined,
      role,
      status,
      joinedAt: joinedAt ?? undefined,
      sharingFloor: sharingFloor ?? undefined,
    })
  );
}

/**
 * Plan / entitlement snapshot for a cloud org (`get_entitlement_state`).
 * `null` on any failure or unexpected shape.
 */
export async function getEntitlementState(
  accessToken: string,
  orgId: string
): Promise<CloudEntitlementState | null> {
  const payload = await callRpc("get_entitlement_state", accessToken, {
    p_org_id: orgId,
  });
  const parsed = EntitlementStateWireSchema.safeParse(payload);
  if (!parsed.success) {
    if (payload !== null) {
      log.warn("get_entitlement_state returned unexpected shape");
    }
    return null;
  }
  const { plan, status, replayRetentionDays, maxOrgMembers } = parsed.data;
  return {
    plan,
    status,
    replayRetentionDays: replayRetentionDays ?? undefined,
    maxOrgMembers: maxOrgMembers ?? undefined,
    sessionSyncEnabled: parsed.data.sessionSyncEnabled ?? undefined,
    orgSharingFloor: parsed.data.orgSharingFloor ?? undefined,
  };
}

/**
 * Standard Supabase (GoTrue) refresh-token exchange. Plain apikey header —
 * no PostgREST profile headers. `null` on any failure.
 */
async function refreshSessionAttempt(
  refreshToken: string,
  endpoint: { supabaseUrl: string; anonKey: string } = getCloudEndpoint()
): Promise<RefreshAttemptResult> {
  const key = `${endpoint.supabaseUrl}\0${endpoint.anonKey}\0${refreshToken}`;
  if (inFlightRefresh?.key === key) return inFlightRefresh.promise;

  const promise = (async (): Promise<RefreshAttemptResult> => {
    try {
      // Transport retry is safe here too: a lost-response race re-sends the
      // previous refresh token, which GoTrue's reuse interval tolerates
      // (same rotated session), and the in-flight dedupe above already
      // serializes concurrent refreshes.
      const response = await fetchWithTransportRetry(
        `${endpoint.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            apikey: endpoint.anonKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        }
      );
      if (!response.ok) {
        log.warn(`token refresh failed with status ${response.status}`);
        return {
          tokens: null,
          permanentlyRejected:
            response.status === 400 || response.status === 401,
        };
      }
      const parsed = RefreshResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        log.warn("token refresh returned unexpected shape");
        return { tokens: null, permanentlyRejected: false };
      }
      return {
        tokens: {
          accessToken: parsed.data.access_token,
          refreshToken: parsed.data.refresh_token,
          expiresAt: parsed.data.expires_at,
        },
        permanentlyRejected: false,
      };
    } catch (error) {
      log.warn("token refresh request error:", error);
      return { tokens: null, permanentlyRejected: false };
    }
  })();
  inFlightRefresh = { key, promise };
  try {
    return await promise;
  } finally {
    if (inFlightRefresh?.promise === promise) inFlightRefresh = undefined;
  }
}

export async function refreshSession(
  refreshToken: string,
  endpoint: { supabaseUrl: string; anonKey: string } = getCloudEndpoint()
): Promise<RefreshedTokens | null> {
  return (await refreshSessionAttempt(refreshToken, endpoint)).tokens;
}

export interface EnsureFreshSessionOptions {
  /** Called only when GoTrue explicitly rejects the refresh credential. */
  onRefreshRejected?: () => void;
}

/**
 * Return `state` unchanged while the access token is comfortably valid;
 * otherwise refresh and return the updated state. The CALLER persists the
 * returned state (this module never touches the atom). `null` means the
 * refresh failed — the caller decides whether to sign the user out.
 */
export async function ensureFreshSession(
  state: Org2CloudAuthState,
  options?: EnsureFreshSessionOptions
): Promise<Org2CloudAuthState | null> {
  const nowSeconds = Date.now() / 1000;
  if (state.expiresAt - nowSeconds > REFRESH_SKEW_SECONDS) {
    return state;
  }
  const attempt = await refreshSessionAttempt(state.refreshToken, {
    supabaseUrl: state.supabaseUrl,
    anonKey: state.supabaseAnonKey,
  });
  const refreshed = attempt.tokens;
  if (!refreshed && attempt.permanentlyRejected) {
    options?.onRefreshRejected?.();
  }
  if (!refreshed) return null;
  return {
    ...state,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
}

/** Re-exported so UI code has one import site. */
export type { Org2CloudProfile };
