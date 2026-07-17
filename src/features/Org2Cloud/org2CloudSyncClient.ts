/**
 * Managed-cloud session sync client (Phase 6, design §8).
 *
 * Typed wrappers for the six `org2_cloud` session-sync RPCs. Same raw-fetch
 * idiom as `org2CloudClient` (JWT Bearer + `Content-Profile: org2_cloud`,
 * no supabase-js), but UNLIKE that client these wrappers THROW on failure —
 * the sync engine needs the server's error codes (ORG2_CONFLICT,
 * ORG2_QUOTA_EXCEEDED, ORG2_SYNC_DISABLED, ORG2_FORBIDDEN,
 * ORG2_RETENTION_EXPIRED, ORG2_SCOPE_COOLDOWN) to drive its OCC re-anchor
 * and backoff paths.
 *
 * Segment bodies are built by the SHARED codec
 * (`TeamCollaboration/sync/segmentCodec`) so managed and self-hosted pushes
 * ship byte-identical `SegmentWirePayload` wire shapes.
 */
import { z } from "zod/v4";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { RemoteTeammateSessionMetadataSchema } from "@src/store/collaboration/protocol";
import type {
  CollabSessionAccessMode,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";

import type { SessionEventsSegmentInput } from "../TeamCollaboration/sync/CollabSyncBackend";
import {
  type SegmentWirePayload,
  toFrozenSegmentWire,
  toTailWire,
} from "../TeamCollaboration/sync/segmentCodec";
import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export const ORG2_SYNC_ERROR_CODES = [
  "ORG2_CONFLICT",
  "ORG2_QUOTA_EXCEEDED",
  "ORG2_SYNC_DISABLED",
  "ORG2_FORBIDDEN",
  "ORG2_RETENTION_EXPIRED",
  // Access ladder (§B): segment read refused (metadata_only / restricted).
  "ORG2_REPLAY_NOT_AVAILABLE",
  // Row absent (never pushed / already tombstoned) — callers that retract
  // opportunistically treat this as success.
  "ORG2_SESSION_NOT_FOUND",
  // Carries a suffix: `ORG2_SCOPE_COOLDOWN <ISO frees-at>` — parse it with
  // `parseScopeCooldownFreesAt` (org2CloudScopeQuota).
  "ORG2_SCOPE_COOLDOWN",
] as const;

export type Org2SyncErrorCode = (typeof ORG2_SYNC_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudSyncError extends Error {
  readonly code: Org2SyncErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudSyncError";
    this.status = status;
    this.code =
      ORG2_SYNC_ERROR_CODES.find((code) => message.includes(code)) ?? null;
  }
}

export function isOrg2SyncErrorCode(
  error: unknown,
  code: Org2SyncErrorCode
): boolean {
  return error instanceof Org2CloudSyncError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing variant of the org2CloudClient idiom)
// ---------------------------------------------------------------------------

function rpcUrl(functionName: string): string {
  return `${getCloudEndpoint().supabaseUrl}/rest/v1/rpc/${functionName}`;
}

function rpcHeaders(accessToken: string | null): Record<string, string> {
  const { anonKey } = getCloudEndpoint();
  return {
    apikey: anonKey,
    authorization: `Bearer ${accessToken ?? anonKey}`,
    "content-type": "application/json",
    "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
  };
}

async function callSyncRpc(
  functionName: string,
  // null ⇒ TICKET tier: anon key as bearer (guest share-token reads only).
  accessToken: string | null,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(rpcUrl(functionName), {
    method: "POST",
    headers: rpcHeaders(accessToken),
    body: JSON.stringify(body),
  });
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
    throw new Org2CloudSyncError(message, response.status);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const CloudSegmentWireSchema = z.object({
  seq: z.number(),
  payloadGz: z.string(),
  eventCount: z.number(),
  segmentHash: z.string(),
});

const CloudSessionEventsSchema = z.object({
  epoch: z.number().nullish().default(null),
  frozenSeq: z.number().nullish().default(null),
  tailHash: z.string().nullish().default(null),
  count: z.number().nullish().default(null),
  segments: z.array(CloudSegmentWireSchema).default([]),
});

const CloudCoolingScopeSchema = z.object({
  scopeKey: z.string(),
  /** ISO timestamp (UTC) when the cooling slot is reclaimed. */
  freesAt: z.string(),
});

const CloudOrgScopeStateSchema = z.object({
  repoScopes: z.array(z.string()).default([]),
  /** Occupancy = active + cooling; can exceed `repoScopes.length`. */
  used: z
    .number()
    .nullish()
    .transform((value) => value ?? 0),
  /** null ⇒ unlimited. */
  cap: z.number().nullish().default(null),
  cooldownDays: z
    .number()
    .nullish()
    .transform((value) => value ?? 0),
  coolingDown: z.array(CloudCoolingScopeSchema).default([]),
});

const CloudOrgSessionsSchema = z.object({
  serverTime: z.string().optional(),
  sessions: z.array(RemoteTeammateSessionMetadataSchema).default([]),
});

export interface CloudSessionEventsSnapshot {
  epoch: number | null;
  frozenSeq: number | null;
  tailHash: string | null;
  /** Total event count (frozen + tail); null ⇒ nothing published yet. */
  count: number | null;
  segments: SegmentWirePayload[];
}

export interface CloudOrgSessions {
  serverTime?: string;
  sessions: RemoteTeammateSessionMetadata[];
}

export type CloudOrgScopeState = z.output<typeof CloudOrgScopeStateSchema>;

// ---------------------------------------------------------------------------
// The six wrappers
// ---------------------------------------------------------------------------

/**
 * Member: repo-scope governance state for one org — the authoritative scope
 * list (hydrates the local mirror on other devices) plus quota occupancy and
 * cooling-down slots.
 */
export async function getOrgRepoScopes(
  accessToken: string,
  orgId: string
): Promise<CloudOrgScopeState> {
  const payload = await callSyncRpc("cloud_get_org_repo_scopes", accessToken, {
    p_org_id: orgId,
  });
  return CloudOrgScopeStateSchema.parse(payload);
}

/**
 * Admin-only: replace the org's repo scopes (normalized remote keys).
 * Removing a scope starts its cooldown server-side; re-adding one whose slot
 * is still cooling raises ORG2_SCOPE_COOLDOWN with an ISO frees-at suffix.
 */
export async function setOrgRepoScopes(
  accessToken: string,
  orgId: string,
  scopes: string[]
): Promise<void> {
  await callSyncRpc("cloud_set_org_repo_scopes", accessToken, {
    p_org_id: orgId,
    scopes,
  });
}

/**
 * Admin-only (0002): set the org sharing FLOOR — the minimum access mode a
 * member may share a session at ('off' | 'metadata_only' | 'full_replay').
 * Throws Org2CloudSyncError on failure (ORG2_ADMIN_REQUIRED for non-admins,
 * ORG2_VALIDATION for a bad value).
 */
export async function setOrgSharingFloor(
  accessToken: string,
  orgId: string,
  floor: CollabSessionAccessMode
): Promise<void> {
  await callSyncRpc("cloud_set_org_sharing_floor", accessToken, {
    p_org_id: orgId,
    p_floor: floor,
  });
}

/**
 * Admin-only: set ONE member's sharing floor (per-member minimum). 'off'
 * clears the member-level requirement — the org-wide floor still applies;
 * the member's effective floor is max(org floor, member floor), merged
 * server-side into their `get_entitlement_state.orgSharingFloor`. Throws
 * Org2CloudSyncError (ORG2_ADMIN_REQUIRED / ORG2_MEMBER_NOT_FOUND /
 * ORG2_VALIDATION).
 */
export async function setMemberSharingFloor(
  accessToken: string,
  orgId: string,
  userId: string,
  floor: CollabSessionAccessMode
): Promise<void> {
  await callSyncRpc("cloud_set_member_sharing_floor", accessToken, {
    p_org_id: orgId,
    p_user_id: userId,
    p_floor: floor,
  });
}

/** Member (owner-updates-only): upsert one session's metadata. */
export async function upsertSessionMetadata(
  accessToken: string,
  orgId: string,
  sessionId: string,
  metadata: RemoteTeammateSessionMetadata
): Promise<void> {
  await callSyncRpc("cloud_upsert_session_metadata", accessToken, {
    p_org_id: orgId,
    p_session_id: sessionId,
    metadata,
  });
}

export interface CloudRewriteSessionEventsInput {
  orgId: string;
  sessionId: string;
  newEpoch: number;
  frozenSegments: SessionEventsSegmentInput[];
  tail: SessionEvent[] | null;
  totalCount: number;
}

/** Owner: epoch-bumped full rewrite of the session's segments. */
export async function rewriteSessionEvents(
  accessToken: string,
  input: CloudRewriteSessionEventsInput
): Promise<void> {
  await callSyncRpc("cloud_rewrite_session_events", accessToken, {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    new_epoch: input.newEpoch,
    frozen_segments: await Promise.all(
      input.frozenSegments.map(toFrozenSegmentWire)
    ),
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  });
}

export interface CloudAppendSessionEventsInput {
  orgId: string;
  sessionId: string;
  /** OCC anchors: mismatch raises ORG2_CONFLICT. */
  expectedEpoch: number;
  expectedFrozenSeq: number;
  expectedTailHash: string | null;
  newFrozenSegments: SessionEventsSegmentInput[];
  tail: SessionEvent[] | null;
  totalCount: number;
}

/** Owner: incremental append (new frozen segments + tail replace). */
export async function appendSessionEvents(
  accessToken: string,
  input: CloudAppendSessionEventsInput
): Promise<void> {
  await callSyncRpc("cloud_append_session_events", accessToken, {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    expected_epoch: input.expectedEpoch,
    expected_frozen_seq: input.expectedFrozenSeq,
    expected_tail_hash: input.expectedTailHash,
    new_frozen_segments: await Promise.all(
      input.newFrozenSegments.map(toFrozenSegmentWire)
    ),
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  });
}

/** Member: retention-windowed session listing for one cloud org. */
export async function listOrgSessions(
  accessToken: string,
  orgId: string,
  since?: string
): Promise<CloudOrgSessions> {
  const payload = await callSyncRpc("cloud_list_org_sessions", accessToken, {
    p_org_id: orgId,
    since: since ?? null,
  });
  const parsed = CloudOrgSessionsSchema.parse(payload);
  // Access-ladder normalization: the cloud column is `events_epoch integer
  // DEFAULT 0 NOT NULL`, so the wire never omits the segment summary — but
  // consumers gate replay/fork/disabled-row on `eventsEpoch === undefined`
  // (the self-hosted "owner published no segments" convention). Without
  // this, a metadata_only row renders clickable and the click dies on the
  // server's ORG2_REPLAY_NOT_AVAILABLE. Strip the summary on rows the
  // access ladder forbids reading anyway.
  return {
    ...parsed,
    sessions: parsed.sessions.map((session) =>
      session.accessMode === "metadata_only"
        ? {
            ...session,
            eventsEpoch: undefined,
            eventsFrozenSeq: undefined,
            eventsCount: undefined,
            eventsTailHash: undefined,
          }
        : session
    ),
  };
}

export interface GetSessionEventsOptions {
  /**
   * Link-share ticket (0012): when set, the request rides the guest token
   * branch — `accessToken` may be null (anon bearer) and the caller is
   * typically not an org member at all.
   */
  shareToken?: string;
  /** Server-side incremental fetch (frozen past the cursor + tail always). */
  afterSeq?: number;
}

/**
 * Member: full segments snapshot for one shared session. Raises
 * ORG2_RETENTION_EXPIRED when the session left the plan's window. Segments
 * are returned as WIRE payloads (gzipped base64) — decode with the shared
 * `decodeSegmentEvents` when replay lands in a later cut.
 *
 * With `options.shareToken` this becomes the TICKET-tier guest read
 * (opaque ORG2_UNAUTHORIZED on every failure). The optional params are only
 * put on the wire when set, so member calls stay byte-identical to the
 * pre-0012 shape.
 */
export async function getSessionEvents(
  accessToken: string | null,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSnapshot> {
  const payload = await callSyncRpc("cloud_get_session_events", accessToken, {
    p_org_id: orgId,
    p_session_id: sessionId,
    ...(options?.shareToken !== undefined
      ? { p_share_token: options.shareToken }
      : {}),
    ...(options?.afterSeq !== undefined
      ? { p_after_seq: options.afterSeq }
      : {}),
  });
  const parsed = CloudSessionEventsSchema.parse(payload);
  return {
    epoch: parsed.epoch,
    frozenSeq: parsed.frozenSeq,
    tailHash: parsed.tailHash,
    count: parsed.count,
    segments: parsed.segments,
  };
}

/**
 * Owner-only soft tombstone: removes a session from the org's shared list
 * (segments are kept server-side). Used when a session is untagged from a
 * cloud org — it should disappear from that org promptly. If the session is
 * still repo-scope-matched, the next sync pass re-creates it (the upsert
 * clears `deleted_at`), so this is safe to call unconditionally on untag.
 */
export async function deleteSession(
  accessToken: string,
  orgId: string,
  sessionId: string
): Promise<void> {
  await callSyncRpc("cloud_delete_session", accessToken, {
    p_org_id: orgId,
    p_session_id: sessionId,
  });
}
