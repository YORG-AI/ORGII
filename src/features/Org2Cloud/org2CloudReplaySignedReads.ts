/**
 * Share-token signed reads for storage-offloaded replay segments.
 *
 * Org members download `replay` bucket objects directly with their JWT
 * (org2CloudStorageClient) — storage RLS delegates to the session read
 * ladder. A share-token guest is not a member and cannot pass that RLS, so
 * guest reads take a three-leg path instead:
 *
 * 1. `cloud_authorize_replay_read(p_org_id, p_session_id, p_share_token)` —
 *    anon-key RPC (no Authorization header; the share token is the only
 *    credential, mirroring the registered-link tier) → `{grant, expiresAt,
 *    objects}`.
 * 2. POST the grant to the deployment web app's signer route
 *    (`{webOrigin}/api/replay/sign`) → `{urls: {storagePath → signedUrl},
 *    expiresIn}`.
 * 3. Plain GET per signed URL — the URL is self-authorizing.
 *
 * `createGuestReplayObjectReader` caches the signed-url map for the reader's
 * lifetime (one import walk) and re-authorizes at most once when the grant
 * or URLs expire mid-walk. A backend without the authorize RPC surfaces the
 * PGRST202-style rejection (`isReplayAuthorizeRpcMissing`) so the caller can
 * fall back to the member download and its pre-0006 failure mode.
 */
import { z } from "zod/v4";

import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import {
  fetchWithTransportRetry,
  isFetchTransportError,
} from "./org2CloudFetchRetry";
import { Org2CloudStorageError } from "./org2CloudStorageClient";
import { Org2CloudSyncError } from "./org2CloudSyncClient";

export const CLOUD_REPLAY_SIGN_PATH = "/api/replay/sign";

const SIGN_RETRY_BACKOFF_MS = 300;

export type Org2CloudSignerErrorCode =
  | "unreachable"
  | "unauthorized"
  | "expired";

/**
 * Signer-route failure with a UI-mappable code. Extends the storage error so
 * existing status-based handling keeps working; `code` is what the import
 * dialog keys its user-facing copy on.
 */
export class Org2CloudSignerError extends Org2CloudStorageError {
  readonly code: Org2CloudSignerErrorCode;

  constructor(
    message: string,
    code: Org2CloudSignerErrorCode,
    status: number | null = null
  ) {
    super(message, status);
    this.name = "Org2CloudSignerError";
    this.code = code;
  }
}

function signerRejectionCode(
  status: number,
  payload: unknown
): Org2CloudSignerErrorCode {
  const detail =
    payload && typeof payload === "object"
      ? String(
          (payload as { error?: unknown }).error ??
            (payload as { message?: unknown }).message ??
            ""
        )
      : "";
  if (status === 410 || /expired/i.test(detail)) return "expired";
  if (status === 401 || status === 403) return "unauthorized";
  return "unreachable";
}

// Trailing .optional() keeps the inferred keys optional (`expiresAt?:`) —
// the protocol.ts idiom — so plain object literals stay assignable.
const CloudReplayReadGrantSchema = z.object({
  grant: z.string(),
  expiresAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  objects: z.array(z.string()).default([]),
});

export type CloudReplayReadGrant = z.output<typeof CloudReplayReadGrantSchema>;

const CloudReplaySignedUrlsSchema = z.object({
  urls: z.record(z.string(), z.string()).default({}),
  expiresIn: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
});

export type CloudReplaySignedUrls = z.output<
  typeof CloudReplaySignedUrlsSchema
>;

/** The authorize RPC does not exist on this backend (pre-0006 signer). */
export function isReplayAuthorizeRpcMissing(error: unknown): boolean {
  return (
    error instanceof Org2CloudSyncError &&
    error.status === 404 &&
    /could not find the function/i.test(error.message)
  );
}

/**
 * Registered-link tier signed-read authorization. Anon key only — no
 * Authorization header and no anon-as-bearer; the share token in the body is
 * the sole capability, so a guest without org membership (or any JWT at all)
 * can call it.
 */
export async function authorizeReplayRead(
  orgId: string,
  sessionId: string,
  shareToken: string,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<CloudReplayReadGrant> {
  const response = await fetchWithTransportRetry(
    `${endpoint.supabaseUrl}/rest/v1/rpc/cloud_authorize_replay_read`,
    {
      method: "POST",
      headers: {
        apikey: endpoint.anonKey,
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify({
        p_org_id: orgId,
        p_session_id: sessionId,
        p_share_token: shareToken,
      }),
      signal,
    }
  );
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `org2_cloud rpc cloud_authorize_replay_read failed with ${response.status}`;
    throw new Org2CloudSyncError(message, response.status);
  }
  return CloudReplayReadGrantSchema.parse(payload);
}

/**
 * Exchange a read grant for the signed-url map at the deployment's signer
 * route. A network-level failure of the POST gets ONE extra retry after a
 * short backoff (on top of fetchWithTransportRetry's immediate dead-socket
 * retry); an HTTP rejection — 401 included — is never retried and maps to a
 * coded Org2CloudSignerError.
 */
export async function signReplayReadUrls(
  grant: string,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<CloudReplaySignedUrls> {
  const url = new URL(CLOUD_REPLAY_SIGN_PATH, endpoint.webOrigin).toString();
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant }),
    signal,
  };
  let response: Response;
  try {
    response = await fetchWithTransportRetry(url, init);
  } catch (error) {
    if (!isFetchTransportError(error) || signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, SIGN_RETRY_BACKOFF_MS));
    if (signal?.aborted) throw error;
    try {
      response = await fetchWithTransportRetry(url, init);
    } catch (retryError) {
      if (!isFetchTransportError(retryError)) throw retryError;
      throw new Org2CloudSignerError(
        "replay signer unreachable after retry",
        "unreachable"
      );
    }
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Org2CloudSignerError(
      `replay sign request failed with ${response.status}`,
      signerRejectionCode(response.status, payload),
      response.status
    );
  }
  return CloudReplaySignedUrlsSchema.parse(payload);
}

/** Plain GET of one signed replay object (the URL is self-authorizing). */
export async function downloadSignedReplayObject(
  url: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetchWithTransportRetry(url, {
    method: "GET",
    signal,
  });
  if (!response.ok) {
    throw new Org2CloudStorageError(
      `signed replay object download failed with ${response.status}`,
      response.status
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

interface SignedReadSession {
  urls: Record<string, string>;
  /** Epoch ms after which the grant/URLs must not be trusted; null = unknown. */
  expiresAtMs: number | null;
}

/** A signed-URL rejection class that a fresh grant can plausibly repair. */
function isSignedUrlRejected(error: unknown): boolean {
  return (
    error instanceof Org2CloudStorageError &&
    error.status !== null &&
    [400, 401, 403, 410].includes(error.status)
  );
}

export interface GuestReplayObjectReader {
  download(storagePath: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Share-token reader over one session's storage-offloaded segments. The
 * authorize+sign round-trip runs once (single-flight across the codec's
 * concurrent segment workers) and its url map is cached for the reader's
 * lifetime; expiry mid-walk — proactive via the reported deadline or
 * reactive via a signed-URL rejection — re-authorizes at most once. A
 * missing authorize RPC rejects every download with the original
 * PGRST202-style error without further network attempts, so the caller's
 * fallback decision stays cheap.
 */
export function createGuestReplayObjectReader(input: {
  orgId: string;
  sessionId: string;
  shareToken: string;
  endpoint?: CloudEndpoint;
}): GuestReplayObjectReader {
  const { orgId, sessionId, shareToken, endpoint } = input;
  let session: Promise<SignedReadSession> | null = null;
  let reauthorized = false;
  let authorizeMissing: Org2CloudSyncError | null = null;

  const establishSession = async (
    signal?: AbortSignal
  ): Promise<SignedReadSession> => {
    const authorized = await authorizeReplayRead(
      orgId,
      sessionId,
      shareToken,
      endpoint,
      signal
    );
    const signedAtMs = Date.now();
    const signed = await signReplayReadUrls(authorized.grant, endpoint, signal);
    const deadlines = [
      authorized.expiresAt !== undefined
        ? Date.parse(authorized.expiresAt)
        : Number.NaN,
      signed.expiresIn !== undefined
        ? signedAtMs + signed.expiresIn * 1000
        : Number.NaN,
    ].filter((deadline) => Number.isFinite(deadline));
    return {
      urls: signed.urls,
      expiresAtMs: deadlines.length > 0 ? Math.min(...deadlines) : null,
    };
  };

  const ensureSession = (signal?: AbortSignal): Promise<SignedReadSession> => {
    if (!session) {
      session = establishSession(signal).catch((error: unknown) => {
        session = null;
        if (isReplayAuthorizeRpcMissing(error)) {
          authorizeMissing = error as Org2CloudSyncError;
        }
        throw error;
      });
    }
    return session;
  };

  const refreshSessionOnce = (
    signal?: AbortSignal
  ): Promise<SignedReadSession> | null => {
    if (reauthorized) return null;
    reauthorized = true;
    session = null;
    return ensureSession(signal);
  };

  return {
    async download(
      storagePath: string,
      signal?: AbortSignal
    ): Promise<Uint8Array> {
      if (authorizeMissing) throw authorizeMissing;
      let current = await ensureSession(signal);
      if (current.expiresAtMs !== null && Date.now() >= current.expiresAtMs) {
        current = (await refreshSessionOnce(signal)) ?? current;
      }
      let url = current.urls[storagePath];
      if (url === undefined) {
        const refreshed = await refreshSessionOnce(signal);
        if (refreshed) url = refreshed.urls[storagePath];
        if (url === undefined) {
          throw new Org2CloudStorageError(
            `no signed url for replay object ${storagePath}`
          );
        }
      }
      try {
        return await downloadSignedReplayObject(url, signal);
      } catch (error) {
        if (!isSignedUrlRejected(error)) throw error;
        const refreshed = await refreshSessionOnce(signal);
        if (!refreshed) throw error;
        const freshUrl = refreshed.urls[storagePath];
        if (freshUrl === undefined) throw error;
        return downloadSignedReplayObject(freshUrl, signal);
      }
    },
  };
}
