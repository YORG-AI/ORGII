/**
 * Managed-cloud per-session shares client (migration 0012).
 *
 * Typed throwing wrappers for the four `org2_cloud` share RPCs, in the
 * `org2CloudSyncClient` idiom (raw fetch, JWT Bearer + `Content-Profile:
 * org2_cloud`, `ORG2_*` code extraction). Two trust tiers:
 *
 * - MEMBER tier (create / revoke / list): JWT-authenticated, distinct error
 *   codes. The client mints the 32-byte link token and sends ONLY its
 *   sha256 — the plaintext exists solely in the returned result (and the
 *   share link the caller builds from it), mirroring the invite-code model.
 * - REGISTERED LINK tier (resolve + the non-member segments fetch in
 *   `org2CloudBackendAdapter`): a valid user JWT proves registration while
 *   the plaintext share token grants access to this one session. Org
 *   membership is deliberately not required. EVERY capability failure is
 *   still the single opaque ORG2_UNAUTHORIZED (no existence oracle).
 */
import { z } from "zod/v4";

import { RemoteTeammateSessionMetadataSchema } from "@src/store/collaboration/protocol";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";
import { sha256Hex } from "./org2CloudOrgManagement";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export const ORG2_SHARE_ERROR_CODES = [
  "ORG2_MEMBER_NOT_FOUND",
  "ORG2_SESSION_NOT_FOUND",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_NOT_FOUND",
  "ORG2_UNAUTHORIZED",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_FORBIDDEN",
  "ORG2_VALIDATION",
] as const;

export type Org2ShareErrorCode = (typeof ORG2_SHARE_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudShareError extends Error {
  readonly code: Org2ShareErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudShareError";
    this.status = status;
    // Whole-token match (org2CloudOrgManagement precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_SHARE_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ShareErrorCode | undefined) ?? null;
  }
}

export function isOrg2ShareErrorCode(
  error: unknown,
  code: Org2ShareErrorCode
): boolean {
  return error instanceof Org2CloudShareError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing; every share operation requires a registered user)
// ---------------------------------------------------------------------------

async function callShareRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetchWithTransportRetry(
    `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: endpoint.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify(body),
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
        : `org2_cloud rpc ${functionName} failed with ${response.status}`;
    throw new Org2CloudShareError(message, response.status);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const CLOUD_SHARE_LEVEL = {
  METADATA: "metadata",
  REPLAY: "replay",
} as const;

export type CloudShareLevel =
  (typeof CLOUD_SHARE_LEVEL)[keyof typeof CLOUD_SHARE_LEVEL];

// Trailing .optional() keeps the inferred keys optional (`expiresAt?:`) —
// the protocol.ts idiom — so plain object literals stay assignable.
const CloudSessionShareWireSchema = z.object({
  id: z.string(),
  granteeUserId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  level: z.string(),
  expiresAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  createdAt: z.string(),
  revokedAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  hasToken: z.boolean(),
});

const CloudSessionSharesSchema = z.object({
  shares: z.array(CloudSessionShareWireSchema).default([]),
});

export type CloudSessionShareRecord = z.output<
  typeof CloudSessionShareWireSchema
>;

/** Active = not revoked and not past its expiry (mirrors the server filter). */
export function isCloudShareActive(
  share: Pick<CloudSessionShareRecord, "revokedAt" | "expiresAt">,
  nowMs: number = Date.now()
): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt) {
    const expiresMs = Date.parse(share.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return false;
  }
  return true;
}

/** Random 32-byte hex share token (same entropy as cloud invite codes). */
export function generateCloudShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

// ---------------------------------------------------------------------------
// The four wrappers
// ---------------------------------------------------------------------------

export interface CreateCloudSessionShareInput {
  orgId: string;
  sessionId: string;
  level: CloudShareLevel;
  /** Directed share target; omit to mint a link share. */
  granteeUserId?: string;
  expiresAt?: string;
}

export interface CreatedCloudSessionShare {
  shareId: string;
  /**
   * Plaintext link token — present for link shares only, shown exactly once
   * (the server stores only the sha256 and can never return it).
   */
  shareToken?: string;
}

/** Owner-only: create a directed member share or a one-shot link share. */
export async function createCloudSessionShare(
  accessToken: string,
  input: CreateCloudSessionShareInput
): Promise<CreatedCloudSessionShare> {
  const shareToken = input.granteeUserId
    ? undefined
    : generateCloudShareToken();
  const payload = await callShareRpc(
    "cloud_create_session_share",
    accessToken,
    {
      p_org_id: input.orgId,
      p_session_id: input.sessionId,
      p_level: input.level,
      p_grantee_user_id: input.granteeUserId ?? null,
      p_token_hash: shareToken ? await sha256Hex(shareToken) : null,
      p_expires_at: input.expiresAt ?? null,
    }
  );
  const shareId = z.object({ shareId: z.string() }).parse(payload).shareId;
  return { shareId, shareToken };
}

/** Share owner or org admin: idempotent tombstone. */
export async function revokeCloudSessionShare(
  accessToken: string,
  orgId: string,
  shareId: string
): Promise<void> {
  await callShareRpc("cloud_revoke_session_share", accessToken, {
    p_org_id: orgId,
    p_share_id: shareId,
  });
}

/** Session-owner-only management listing (active + revoked, hasToken flag). */
export async function listCloudSessionShares(
  accessToken: string,
  orgId: string,
  sessionId: string
): Promise<CloudSessionShareRecord[]> {
  const payload = await callShareRpc("cloud_list_session_shares", accessToken, {
    p_org_id: orgId,
    p_session_id: sessionId,
  });
  return CloudSessionSharesSchema.parse(payload).shares;
}

/**
 * Registered-link tier: resolve a link token to the bound session's
 * listing-row projection (metadata blob + orgId/sessionId coordinates +
 * events summary). The caller must be signed in but need not belong to the
 * source org. Every capability failure throws with the opaque
 * ORG2_UNAUTHORIZED.
 */
export async function resolveCloudSessionShare(
  accessToken: string,
  shareToken: string,
  endpoint?: CloudEndpoint,
  signal?: AbortSignal
): Promise<RemoteTeammateSessionMetadata> {
  const payload = await callShareRpc(
    "cloud_resolve_session_share",
    accessToken,
    { p_share_token: shareToken },
    endpoint,
    signal
  );
  return RemoteTeammateSessionMetadataSchema.parse(payload);
}
