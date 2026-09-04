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
import type { OrgRuntimeTelemetry } from "./memberRuntime/types";
import {
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  type Org2CloudAuthState,
  type Org2CloudProfile,
  org2CloudAuthIdentityKey,
  parseStoredOrg2CloudAuth,
} from "./org2CloudAuthAtom";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "./org2CloudFetchRetry";
import { CLOUD_ORG_ROLES, type CloudOrgRole } from "./org2CloudOrgManagement";

const log = createLogger("Org2CloudClient");

/** Refresh when the access token expires within this many seconds. */
const REFRESH_SKEW_SECONDS = 60;
/** A dead WKWebView fetch must not hold every auth-gated single-flight forever. */
const AUTH_REFRESH_TIMEOUT_MS = 15_000;

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

export type CloudRpcEndpoint = Pick<
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
  endpoint: CloudRpcEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<unknown | null> {
  try {
    const response = await fetchWithTransportRetry(
      rpcUrl(functionName, endpoint),
      {
        method: "POST",
        headers: rpcHeaders(accessToken, endpoint),
        body: JSON.stringify(body ?? {}),
        signal,
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
 * Raw 0005+ capability read; `null` on pre-0005 backends (PGRST202) and on
 * transport failure. Interpretation/caching live in `org2CloudCapabilities`.
 */
export async function getCloudCapabilitiesRaw(
  accessToken: string,
  signal?: AbortSignal,
  endpoint?: CloudRpcEndpoint
): Promise<unknown | null> {
  return callRpc(
    "get_cloud_capabilities",
    accessToken,
    undefined,
    endpoint ?? getCloudEndpoint(),
    signal
  );
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

/**
 * Rename the signed-in user's display name (0008 `update_cloud_profile`).
 * Returns the stored name, or `null` on any failure — including pre-0008
 * backends, where the RPC is absent.
 */
export async function updateCloudProfileDisplayName(
  accessToken: string,
  displayName: string
): Promise<string | null> {
  const payload = await callRpc("update_cloud_profile", accessToken, {
    p_display_name: displayName,
  });
  const parsed = z.object({ displayName: z.string() }).safeParse(payload);
  return parsed.success ? parsed.data.displayName : null;
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

function normalizeEntitlementWire(
  parsed: z.infer<typeof EntitlementStateWireSchema>
): CloudEntitlementState {
  return {
    plan: parsed.plan,
    status: parsed.status,
    replayRetentionDays: parsed.replayRetentionDays ?? undefined,
    maxOrgMembers: parsed.maxOrgMembers ?? undefined,
    sessionSyncEnabled: parsed.sessionSyncEnabled ?? undefined,
    orgSharingFloor: parsed.orgSharingFloor ?? undefined,
  };
}

const CloudOrgWireSchema = z.object({
  orgId: z.string(),
  name: z.string(),
  role: z.enum(CLOUD_ORG_ROLES),
  // 0004 backends resolve each org's entitlement inside the roster listing;
  // null/absent (older or degraded backends, or one failing org) falls back
  // to the per-org RPC for exactly that org. `.catch(undefined)` keeps a
  // malformed entitlement from failing the whole roster parse.
  entitlement: EntitlementStateWireSchema.nullish().catch(undefined),
  // 0007 org-sharding directory hook (design §7 step 3): the Supabase origin
  // hosting this org's data plane. null/absent (pre-0007 backends, or an org
  // living on the active project) ⇒ the active endpoint. `.catch(undefined)`
  // keeps a malformed value from failing the whole roster parse.
  homeEndpoint: z.string().nullish().catch(undefined),
  // 0010 member-runtime sharing: the org's `runtime_telemetry` record.
  // null/absent (pre-0010 backends, or telemetry never configured) ⇒ the
  // feature is OFF for this org. `.catch(undefined)` degrades a malformed
  // record to "off" instead of failing the whole roster parse.
  runtimeTelemetry: z
    .object({ enabled: z.boolean(), intervalMinutes: z.number() })
    .nullish()
    .catch(undefined),
  // 0013 legacy wire name for org-level background upload: absent
  // (pre-0013 backends) ⇒ off. `.catch(undefined)` keeps a malformed value
  // from failing the roster.
  offlineSyncEnabled: z.boolean().nullish().catch(undefined),
});

export interface CloudOrg {
  orgId: string;
  name: string;
  role: CloudOrgRole;
  entitlement?: CloudEntitlementState;
  /** 0007 directory hook; absent ⇒ the org lives on the active endpoint. */
  homeEndpoint?: string;
  /** 0010 member-runtime telemetry record; absent/null ⇒ feature off. */
  runtimeTelemetry?: OrgRuntimeTelemetry | null;
  /** 0013 legacy wire field for background upload; absent ⇒ off. */
  offlineSyncEnabled?: boolean;
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
  return parsed.data.map(
    ({
      orgId,
      name,
      role,
      entitlement,
      homeEndpoint,
      runtimeTelemetry,
      offlineSyncEnabled,
    }) => ({
      orgId,
      name,
      role,
      ...(entitlement
        ? { entitlement: normalizeEntitlementWire(entitlement) }
        : {}),
      ...(homeEndpoint ? { homeEndpoint } : {}),
      ...(runtimeTelemetry ? { runtimeTelemetry } : {}),
      ...(offlineSyncEnabled !== undefined && offlineSyncEnabled !== null
        ? { offlineSyncEnabled }
        : {}),
    })
  );
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
  return normalizeEntitlementWire(parsed.data);
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
      const { response, payload } = await runCloudRequestWithTimeout(
        async (signal) => {
          const response = await fetchWithTransportRetry(
            `${endpoint.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
            {
              method: "POST",
              headers: {
                apikey: endpoint.anonKey,
                "content-type": "application/json",
              },
              body: JSON.stringify({ refresh_token: refreshToken }),
              signal,
            }
          );
          return {
            response,
            payload: response.ok ? await response.json() : null,
          };
        },
        AUTH_REFRESH_TIMEOUT_MS
      );
      if (!response.ok) {
        log.warn(`token refresh failed with status ${response.status}`);
        return {
          tokens: null,
          permanentlyRejected:
            response.status === 400 || response.status === 401,
        };
      }
      const parsed = RefreshResponseSchema.safeParse(payload);
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

function hasComfortablyFreshAccessToken(
  state: Org2CloudAuthState,
  nowSeconds: number
): boolean {
  return state.expiresAt - nowSeconds > REFRESH_SKEW_SECONDS;
}

/**
 * Cross-window mutex for the ROTATING refresh-token exchange. The per-realm
 * `inFlightRefresh` dedupe cannot see another OS window's webview realm, and
 * two windows racing the same rotating token make the loser permanently
 * rejected (GoTrue reuse detection) — which signs the user out. Web Locks
 * are shared across same-origin webviews (WKWebView / WebView2 both support
 * them); where the API is absent the current single-window behavior stands.
 * Callbacks passed here must not throw: a lock-manager error falls back to
 * running the callback unserialized.
 */
const TOKEN_REFRESH_LOCK_NAME = "orgii:org2cloud-token-refresh";

async function withCrossWindowRefreshLock<T>(
  run: () => Promise<T>
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return run();
  try {
    return (await locks.request(
      TOKEN_REFRESH_LOCK_NAME,
      { mode: "exclusive" },
      run
    )) as T;
  } catch (error) {
    log.warn("cross-window refresh lock unavailable:", error);
    return run();
  }
}

/** The exact persisted auth payload the auth atom writes; `null` on any
 * parse/storage failure. */
function readPersistedOrg2CloudAuth(): Org2CloudAuthState | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return parseStoredOrg2CloudAuth(
      localStorage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

/**
 * Cross-window refresh short-circuit: while this realm waited on the refresh
 * mutex, another window may have already rotated the same session and
 * persisted the result. Returns the caller's state carrying the persisted
 * rotation when that happened (no exchange needed); `null` means the
 * exchange must still run. Only a persisted session for the SAME identity
 * (endpoint + user) with a comfortably fresh access token counts — another
 * account/endpoint or a stale persisted copy never short-circuits.
 */
export function adoptPersistedSessionRotation(
  state: Org2CloudAuthState,
  persisted: Org2CloudAuthState | null,
  nowSeconds: number
): Org2CloudAuthState | null {
  if (!persisted) return null;
  if (org2CloudAuthIdentityKey(persisted) !== org2CloudAuthIdentityKey(state)) {
    return null;
  }
  if (!hasComfortablyFreshAccessToken(persisted, nowSeconds)) return null;
  return {
    ...state,
    accessToken: persisted.accessToken,
    refreshToken: persisted.refreshToken,
    expiresAt: persisted.expiresAt,
  };
}

interface EnsureFreshSessionOutcome {
  session: Org2CloudAuthState | null;
  permanentlyRejected: boolean;
}

/**
 * Return `state` unchanged while the access token is comfortably valid;
 * otherwise refresh and return the updated state. The CALLER persists the
 * returned state (this module never touches the atom). `null` means the
 * refresh failed — the caller decides whether to sign the user out.
 *
 * The exchange itself runs under two serialization layers: the per-realm
 * `inFlightRefresh` single-flight, plus the cross-window Web Lock (with a
 * persisted-rotation re-read after acquiring it, so a realm that lost the
 * race adopts the winner's tokens instead of burning the rotated one).
 */
export async function ensureFreshSession(
  state: Org2CloudAuthState,
  options?: EnsureFreshSessionOptions
): Promise<Org2CloudAuthState | null> {
  if (hasComfortablyFreshAccessToken(state, Date.now() / 1000)) {
    return state;
  }
  const outcome = await withCrossWindowRefreshLock<EnsureFreshSessionOutcome>(
    async () => {
      const adopted = adoptPersistedSessionRotation(
        state,
        readPersistedOrg2CloudAuth(),
        Date.now() / 1000
      );
      if (adopted) return { session: adopted, permanentlyRejected: false };
      const attempt = await refreshSessionAttempt(state.refreshToken, {
        supabaseUrl: state.supabaseUrl,
        anonKey: state.supabaseAnonKey,
      });
      const refreshed = attempt.tokens;
      return {
        session: refreshed
          ? {
              ...state,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
            }
          : null,
        permanentlyRejected: attempt.permanentlyRejected,
      };
    }
  );
  // Outside the locked region: a caller-supplied handler must not be able to
  // throw inside the lock callback (see withCrossWindowRefreshLock).
  if (!outcome.session && outcome.permanentlyRejected) {
    options?.onRefreshRejected?.();
  }
  return outcome.session;
}

/** Re-exported so UI code has one import site. */
export type { Org2CloudProfile };
