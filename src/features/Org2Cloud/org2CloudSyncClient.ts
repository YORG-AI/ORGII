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
import { createLogger } from "@src/hooks/logger";
import { RemoteTeammateSessionMetadataSchema } from "@src/store/collaboration/protocol";
import type {
  CollabSessionAccessMode,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";

import {
  SESSION_EVENT_WIRE_MAX_PAGE_BYTES,
  SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS,
  SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES,
  type SessionEventWirePage,
  type SessionEventWirePageCursor,
  type SessionEventsSegmentInput,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import {
  type SegmentWirePayload,
  mapSegmentsBounded,
  toFrozenSegmentStorage,
  toFrozenSegmentWire,
  toTailWire,
} from "../TeamCollaboration/sync/segmentCodec";
import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "./org2CloudFetchRetry";
import {
  buildReplayObjectPath,
  uploadReplayObject,
} from "./org2CloudStorageClient";

const cloudSegmentWireEncoder = new TextEncoder();
/** JSON envelope/cursors in addition to the server-counted segment bytes. */
const CLOUD_WIRE_PAGE_RESPONSE_OVERHEAD_BYTES = 64 * 1024;

function cloudSegmentWireBytes(segment: CloudSegmentWire): number {
  return cloudSegmentWireEncoder.encode(JSON.stringify(segment)).byteLength;
}

function assertCloudSegmentWireBudget(
  segment: SegmentWirePayload | Omit<SegmentWirePayload, "seq">
): void {
  const wireBytes = cloudSegmentWireBytes(segment);
  if (wireBytes > SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES) {
    throw new Error(
      `Cloud segment wire is ${wireBytes} bytes (limit ${SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES}); ` +
        "the current SessionEvent[] RPC cannot split one event, so a versioned attachment wire is required"
    );
  }
}

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

function rpcUrl(functionName: string, endpoint: CloudEndpoint): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

function rpcHeaders(
  accessToken: string,
  endpoint: CloudEndpoint
): Record<string, string> {
  const { anonKey } = endpoint;
  return {
    apikey: anonKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
  };
}

async function callSyncRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal,
  timeoutMs?: number,
  responseByteLimit?: number
): Promise<unknown> {
  const execute = async (requestSignal?: AbortSignal): Promise<unknown> => {
    const response = await fetchWithTransportRetry(
      rpcUrl(functionName, endpoint),
      {
        method: "POST",
        headers: rpcHeaders(accessToken, endpoint),
        body: JSON.stringify(body),
        signal: requestSignal,
      }
    );
    const text = await readSyncRpcResponseText(response, responseByteLimit);
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
  };
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  if (timeoutMs === undefined) return execute(signal);
  return runCloudRequestWithTimeout(execute, timeoutMs, signal);
}

async function readSyncRpcResponseText(
  response: Response,
  byteLimit?: number
): Promise<string> {
  if (byteLimit === undefined) return response.text();

  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > byteLimit) {
    throw new CloudSessionWirePageContractError(
      `cloud_get_session_events response declares ${declaredBytes} bytes (limit ${byteLimit})`
    );
  }
  if (!response.body) {
    const text = await response.text();
    const bytes = cloudSegmentWireEncoder.encode(text).byteLength;
    if (bytes > byteLimit) {
      throw new CloudSessionWirePageContractError(
        `cloud_get_session_events response is ${bytes} bytes (limit ${byteLimit})`
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > byteLimit) {
        await reader.cancel("bounded cloud response exceeded byte limit");
        throw new CloudSessionWirePageContractError(
          `cloud_get_session_events response exceeded ${byteLimit} bytes`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const CloudSegmentWireSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    // 0006 storage offload: a frozen segment carries storagePath XOR the
    // legacy inline payloadGz. The tail (seq 0) is always inline.
    payloadGz: z.string().nullish(),
    storagePath: z.string().nullish(),
    eventCount: z.number().int().nonnegative(),
    segmentHash: z.string(),
  })
  .refine(
    (segment) => segment.payloadGz != null || segment.storagePath != null,
    { message: "segment carries neither payloadGz nor storagePath" }
  );

const CloudSessionEventWirePageCursorSchema = z.discriminatedUnion(
  "direction",
  [
    z.object({
      direction: z.literal("forward"),
      afterSeq: z.number().int().nonnegative(),
      throughSeq: z.number().int().nonnegative().optional(),
    }),
    z.object({
      direction: z.literal("backward"),
      beforeSeq: z.number().int().positive().optional(),
    }),
  ]
);

const CloudSessionEventsSchema = z.object({
  epoch: z.number().nullish().default(null),
  frozenSeq: z.number().nullish().default(null),
  tailHash: z.string().nullish().default(null),
  count: z.number().nullish().default(null),
  segments: z.array(CloudSegmentWireSchema).default([]),
});

/**
 * New bounded reads deliberately require every pagination field. Parsing an
 * old server's full-snapshot response with this schema fails closed instead
 * of silently recreating the #443 full-history path.
 */
const CloudSessionEventWirePageSchema = z.object({
  epoch: z.number().nullish().default(null),
  frozenSeq: z.number().int().nonnegative().nullish().default(null),
  tailHash: z.string().nullish().default(null),
  count: z.number().int().nonnegative().nullish().default(null),
  segments: z.array(CloudSegmentWireSchema),
  direction: z.enum(["forward", "backward"]),
  tailIncluded: z.boolean(),
  hasMore: z.boolean(),
  nextCursor: CloudSessionEventWirePageCursorSchema.nullable(),
  returnedWireBytes: z.number().int().nonnegative(),
});

const CloudSessionEventsPageSchema = CloudSessionEventsSchema.extend({
  nextAfterSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/**
 * Keep each PostgREST response comfortably below the 15 s statement timeout.
 * One frozen segment is capped at 256 KiB before gzip. The server cap of 64
 * bounds a page to roughly 16 MiB of canonical event JSON while cutting a
 * gigabyte replay from ~100 network/IPC round trips to ~25.
 */
const SESSION_EVENTS_PAGE_SIZE = 64;
/** Corruption/runaway guard: 65,536 frozen segments at the page size above. */
const MAX_SESSION_EVENT_PAGES = 4_096;

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

const log = createLogger("Org2CloudSyncClient");

const CloudOrgSessionsSchema = z.object({
  serverTime: z.string().optional(),
  sessions: z.array(RemoteTeammateSessionMetadataSchema).default([]),
  // 0005 backends return a keyset cursor when a bounded page has more rows;
  // absent on legacy backends and on the final page. `.catch(undefined)`
  // degrades a malformed cursor to "no more pages" instead of failing the
  // whole listing parse.
  nextCursor: z
    .object({ updatedAt: z.string(), sessionId: z.string() })
    .nullish()
    .catch(undefined),
});

/** Read-side segment wire: inline (`payloadGz`) or offloaded (`storagePath`). */
export interface CloudSegmentWire {
  seq?: number;
  payloadGz?: string | null;
  storagePath?: string | null;
  eventCount: number;
  segmentHash: string;
}

export interface CloudSessionEventsSnapshot {
  epoch: number | null;
  frozenSeq: number | null;
  tailHash: string | null;
  /** Total event count (frozen + tail); null ⇒ nothing published yet. */
  count: number | null;
  segments: CloudSegmentWire[];
}

export interface CloudSessionEventWirePage extends Omit<
  SessionEventWirePage,
  "segments"
> {
  segments: CloudSegmentWire[];
}

/** A server/client contract failure; callers must not retry via full fetch. */
export class CloudSessionWirePageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSessionWirePageContractError";
  }
}

export type CloudSessionEventsSummary = Omit<
  CloudSessionEventsSnapshot,
  "segments"
>;

export interface CloudOrgSessions {
  serverTime?: string;
  sessions: RemoteTeammateSessionMetadata[];
}

/** Rows per page for full listings against a 0005 backend. */
export const SESSION_LISTING_PAGE_SIZE = 200;
/** Runaway guard: a full listing never walks more pages than this. */
const SESSION_LISTING_MAX_PAGES = 50;
/** supabaseUrl set of backends that rejected the paged signature (pre-0005). */
const paginationUnsupportedEndpoints = new Set<string>();

function isRpcSignatureUnsupported(error: unknown): boolean {
  return (
    error instanceof Org2CloudSyncError &&
    error.status === 404 &&
    /could not find the function/i.test(error.message)
  );
}

export const __SESSION_LISTING_INTERNALS = {
  resetPaginationSupport: () => paginationUnsupportedEndpoints.clear(),
};

/** supabaseUrl set of backends that rejected the storage segment wire (pre-0006). */
const storageSegmentsUnsupportedEndpoints = new Set<string>();

export const __STORAGE_SEGMENTS_INTERNALS = {
  resetStorageSupport: () => storageSegmentsUnsupportedEndpoints.clear(),
};

async function shouldUseStorageSegments(
  accessToken: string,
  endpoint: CloudEndpoint
): Promise<boolean> {
  if (storageSegmentsUnsupportedEndpoints.has(endpoint.supabaseUrl)) {
    return false;
  }
  return (await getCloudCapabilities(accessToken)).storageSegments;
}

interface CloudStorageSegmentWire {
  seq: number;
  storagePath: string;
  eventCount: number;
  segmentHash: string;
}

/** Upload each frozen segment's raw gzip bytes, then describe it by path. */
async function uploadFrozenSegmentsToStorage(
  accessToken: string,
  endpoint: CloudEndpoint,
  orgId: string,
  sessionId: string,
  epoch: number,
  segments: SessionEventsSegmentInput[]
): Promise<CloudStorageSegmentWire[]> {
  return mapSegmentsBounded(segments, async (segment) => {
    const encoded = await toFrozenSegmentStorage(segment);
    const storagePath = buildReplayObjectPath(
      orgId,
      sessionId,
      epoch,
      encoded.seq,
      encoded.segmentHash
    );
    await uploadReplayObject(accessToken, storagePath, encoded.bytes, endpoint);
    return {
      seq: encoded.seq,
      storagePath,
      eventCount: encoded.eventCount,
      segmentHash: encoded.segmentHash,
    };
  });
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

export interface CloudRewriteSessionEventWiresInput {
  orgId: string;
  sessionId: string;
  newEpoch: number;
  frozenSegments: SegmentWirePayload[];
  tail: Omit<SegmentWirePayload, "seq"> | null;
  totalCount: number;
}

/** Owner: forward Rust-prepared bounded wires without decoding/re-encoding. */
export async function rewriteSessionEventWires(
  accessToken: string,
  input: CloudRewriteSessionEventWiresInput
): Promise<void> {
  for (const segment of input.frozenSegments) {
    assertCloudSegmentWireBudget(segment);
  }
  if (input.tail) assertCloudSegmentWireBudget(input.tail);
  await callSyncRpc("cloud_rewrite_session_events", accessToken, {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    new_epoch: input.newEpoch,
    frozen_segments: input.frozenSegments,
    tail: input.tail,
    total_count: input.totalCount,
  });
}

/** Owner: epoch-bumped full rewrite of the session's segments. */
export async function rewriteSessionEvents(
  accessToken: string,
  input: CloudRewriteSessionEventsInput
): Promise<void> {
  const endpoint = getCloudEndpoint();
  const baseBody = {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    new_epoch: input.newEpoch,
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  };
  if (
    input.frozenSegments.length > 0 &&
    (await shouldUseStorageSegments(accessToken, endpoint))
  ) {
    const frozenSegments = await uploadFrozenSegmentsToStorage(
      accessToken,
      endpoint,
      input.orgId,
      input.sessionId,
      input.newEpoch,
      input.frozenSegments
    );
    try {
      await callSyncRpc(
        "cloud_rewrite_session_events",
        accessToken,
        { ...baseBody, frozen_segments: frozenSegments },
        endpoint
      );
      return;
    } catch (error) {
      if (!isRpcSignatureUnsupported(error)) throw error;
      storageSegmentsUnsupportedEndpoints.add(endpoint.supabaseUrl);
    }
  }
  await callSyncRpc(
    "cloud_rewrite_session_events",
    accessToken,
    {
      ...baseBody,
      // Bounded encode: `Promise.all` over every segment materializes all
      // canonical/gzip/base64 buffers simultaneously and multiplies RSS.
      frozen_segments: await mapSegmentsBounded(
        input.frozenSegments,
        toFrozenSegmentWire
      ),
    },
    endpoint
  );
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

export interface CloudAppendSessionEventWiresInput {
  orgId: string;
  sessionId: string;
  expectedEpoch: number;
  expectedFrozenSeq: number;
  expectedTailHash: string | null;
  newFrozenSegments: SegmentWirePayload[];
  tail: Omit<SegmentWirePayload, "seq"> | null;
  totalCount: number;
}

/** Owner: forward Rust-prepared bounded wires without renderer hydration. */
export async function appendSessionEventWires(
  accessToken: string,
  input: CloudAppendSessionEventWiresInput
): Promise<void> {
  for (const segment of input.newFrozenSegments) {
    assertCloudSegmentWireBudget(segment);
  }
  if (input.tail) assertCloudSegmentWireBudget(input.tail);
  await callSyncRpc("cloud_append_session_events", accessToken, {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    expected_epoch: input.expectedEpoch,
    expected_frozen_seq: input.expectedFrozenSeq,
    expected_tail_hash: input.expectedTailHash,
    new_frozen_segments: input.newFrozenSegments,
    tail: input.tail,
    total_count: input.totalCount,
  });
}

/** Owner: incremental append (new frozen segments + tail replace). */
export async function appendSessionEvents(
  accessToken: string,
  input: CloudAppendSessionEventsInput
): Promise<void> {
  const endpoint = getCloudEndpoint();
  const baseBody = {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    expected_epoch: input.expectedEpoch,
    expected_frozen_seq: input.expectedFrozenSeq,
    expected_tail_hash: input.expectedTailHash,
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  };
  if (
    input.newFrozenSegments.length > 0 &&
    (await shouldUseStorageSegments(accessToken, endpoint))
  ) {
    const newFrozenSegments = await uploadFrozenSegmentsToStorage(
      accessToken,
      endpoint,
      input.orgId,
      input.sessionId,
      input.expectedEpoch,
      input.newFrozenSegments
    );
    try {
      await callSyncRpc(
        "cloud_append_session_events",
        accessToken,
        { ...baseBody, new_frozen_segments: newFrozenSegments },
        endpoint
      );
      return;
    } catch (error) {
      if (!isRpcSignatureUnsupported(error)) throw error;
      storageSegmentsUnsupportedEndpoints.add(endpoint.supabaseUrl);
    }
  }
  await callSyncRpc(
    "cloud_append_session_events",
    accessToken,
    {
      ...baseBody,
      new_frozen_segments: await mapSegmentsBounded(
        input.newFrozenSegments,
        toFrozenSegmentWire
      ),
    },
    endpoint
  );
}

/** Member: retention-windowed session listing for one cloud org. */
export async function listOrgSessions(
  accessToken: string,
  orgId: string,
  since?: string,
  signal?: AbortSignal
): Promise<CloudOrgSessions> {
  const endpoint = getCloudEndpoint();
  const legacyCall = async () => {
    const payload = await callSyncRpc(
      "cloud_list_org_sessions",
      accessToken,
      {
        p_org_id: orgId,
        since: since ?? null,
      },
      endpoint,
      signal,
      15_000
    );
    return CloudOrgSessionsSchema.parse(payload);
  };

  let parsed: z.output<typeof CloudOrgSessionsSchema>;
  if (
    since !== undefined ||
    paginationUnsupportedEndpoints.has(endpoint.supabaseUrl)
  ) {
    // Delta pulls stay single-shot (bounded by the cursor overlap); known
    // pre-0005 backends keep the legacy unbounded call.
    parsed = await legacyCall();
  } else {
    // Full listing: walk bounded keyset pages so a large org can never push
    // one giant aggregate through the managed statement timeout.
    const sessions: RemoteTeammateSessionMetadata[] = [];
    let serverTime: string | undefined;
    let cursor: { updatedAt: string; sessionId: string } | undefined;
    let page = 0;
    for (;;) {
      let payload: unknown;
      try {
        payload = await callSyncRpc(
          "cloud_list_org_sessions",
          accessToken,
          {
            p_org_id: orgId,
            since: null,
            p_limit: SESSION_LISTING_PAGE_SIZE,
            p_cursor_updated_at: cursor?.updatedAt ?? null,
            p_cursor_session_id: cursor?.sessionId ?? null,
          },
          endpoint,
          signal,
          15_000
        );
      } catch (error) {
        if (page === 0 && isRpcSignatureUnsupported(error)) {
          paginationUnsupportedEndpoints.add(endpoint.supabaseUrl);
          parsed = await legacyCall();
          break;
        }
        throw error;
      }
      const pageParsed = CloudOrgSessionsSchema.parse(payload);
      sessions.push(...pageParsed.sessions);
      serverTime = pageParsed.serverTime ?? serverTime;
      cursor = pageParsed.nextCursor ?? undefined;
      page += 1;
      if (!cursor) {
        parsed = { serverTime, sessions };
        break;
      }
      if (page >= SESSION_LISTING_MAX_PAGES) {
        log.warn(
          `cloud_list_org_sessions stopped after ${page} pages for org ${orgId}`
        );
        parsed = { serverTime, sessions };
        break;
      }
    }
  }
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

interface GetSessionEventsTransportOptions {
  /**
   * Link-share capability (0012): when set, a registered non-member can read
   * the shared session. The user JWT proves registration; this token grants
   * access to the one session.
   */
  shareToken?: string;
  /** Endpoint snapshot shared with a preceding share-token resolve. */
  endpoint?: CloudEndpoint;
  /** Cancels the network read (dialog close / attempt supersession). */
  signal?: AbortSignal;
}

/** Legacy decoded-snapshot callers. New imports must use the bounded shape. */
export interface GetSessionEventsOptions extends GetSessionEventsTransportOptions {
  /** Server-side incremental fetch (frozen past the cursor + tail always). */
  afterSeq?: number;
}

/**
 * Raw bounded physical-row request. The discriminant prevents a caller from
 * accidentally supplying limits while still receiving the permissive legacy
 * response schema.
 */
export interface GetSessionEventWirePageOptions extends GetSessionEventsTransportOptions {
  boundedWirePage: true;
  cursor: SessionEventWirePageCursor;
  includeTail: boolean;
  maxSegments: number;
  maxWireBytes: number;
}

function assertSafeSequence(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudSessionWirePageContractError(
      `${field} must be a non-negative safe integer`
    );
  }
}

function assertWirePageRequest(options: GetSessionEventWirePageOptions): void {
  if (
    !Number.isSafeInteger(options.maxSegments) ||
    options.maxSegments < 1 ||
    options.maxSegments > SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS
  ) {
    throw new CloudSessionWirePageContractError(
      `maxSegments must be between 1 and ${SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS}`
    );
  }
  if (
    !Number.isSafeInteger(options.maxWireBytes) ||
    options.maxWireBytes < 1 ||
    options.maxWireBytes > SESSION_EVENT_WIRE_MAX_PAGE_BYTES
  ) {
    throw new CloudSessionWirePageContractError(
      `maxWireBytes must be between 1 and ${SESSION_EVENT_WIRE_MAX_PAGE_BYTES}`
    );
  }
  if (options.cursor.direction === "forward") {
    assertSafeSequence(options.cursor.afterSeq, "afterSeq");
    if (options.cursor.throughSeq !== undefined) {
      assertSafeSequence(options.cursor.throughSeq, "throughSeq");
      if (options.cursor.throughSeq < options.cursor.afterSeq) {
        throw new CloudSessionWirePageContractError(
          "throughSeq must not precede afterSeq"
        );
      }
    }
  } else if (options.cursor.beforeSeq !== undefined) {
    assertSafeSequence(options.cursor.beforeSeq, "beforeSeq");
    if (options.cursor.beforeSeq === 0) {
      throw new CloudSessionWirePageContractError(
        "beforeSeq must be positive because seq 0 is the mutable tail"
      );
    }
  }
}

function failWirePage(message: string): never {
  throw new CloudSessionWirePageContractError(message);
}

function validateWirePageResponse(
  page: z.output<typeof CloudSessionEventWirePageSchema>,
  options: GetSessionEventWirePageOptions
): CloudSessionEventWirePage {
  if (page.direction !== options.cursor.direction) {
    failWirePage(
      `server returned ${page.direction} page for a ${options.cursor.direction} request`
    );
  }
  if (page.tailIncluded !== options.includeTail) {
    failWirePage("server did not honor the requested tail inclusion state");
  }
  if (page.segments.length > options.maxSegments) {
    failWirePage(
      `server returned ${page.segments.length} segments (requested at most ${options.maxSegments})`
    );
  }

  const seenSeq = new Set<number>();
  const frozenSeqs: number[] = [];
  let tailSegment: (typeof page.segments)[number] | null = null;
  let actualWireBytes = 0;
  for (const [index, segment] of page.segments.entries()) {
    if (seenSeq.has(segment.seq)) {
      failWirePage(`server returned duplicate physical seq ${segment.seq}`);
    }
    seenSeq.add(segment.seq);
    const segmentBytes = cloudSegmentWireBytes(segment);
    if (segmentBytes > SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES) {
      failWirePage(
        `server returned ${segmentBytes}-byte segment ${segment.seq} (hard limit ${SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES})`
      );
    }
    actualWireBytes += segmentBytes;
    if (segment.seq === 0) {
      if (index !== page.segments.length - 1) {
        failWirePage("server returned the mutable tail before frozen rows");
      }
      tailSegment = segment;
    } else {
      const previousFrozenSeq = frozenSeqs.at(-1);
      if (previousFrozenSeq !== undefined && segment.seq <= previousFrozenSeq) {
        failWirePage("server returned frozen rows out of physical-seq order");
      }
      frozenSeqs.push(segment.seq);
    }
  }
  if (
    actualWireBytes > options.maxWireBytes ||
    actualWireBytes > SESSION_EVENT_WIRE_MAX_PAGE_BYTES
  ) {
    failWirePage(
      `server returned ${actualWireBytes} wire bytes (requested at most ${options.maxWireBytes})`
    );
  }
  if (page.returnedWireBytes !== actualWireBytes) {
    failWirePage(
      `server reported ${page.returnedWireBytes} wire bytes but returned ${actualWireBytes}`
    );
  }
  if (tailSegment && !page.tailIncluded) {
    failWirePage("server returned a mutable tail on a tail-free page");
  }
  if (page.tailIncluded && page.tailHash !== null && !tailSegment) {
    failWirePage("server omitted the requested non-empty mutable tail");
  }
  if (tailSegment && tailSegment.segmentHash !== page.tailHash) {
    failWirePage("server tail row does not match the snapshot tailHash");
  }
  if (page.hasMore !== (page.nextCursor !== null)) {
    failWirePage("hasMore and nextCursor disagree");
  }
  if (page.nextCursor && page.nextCursor.direction !== page.direction) {
    failWirePage("nextCursor changes pagination direction");
  }

  const firstFrozenSeq = frozenSeqs[0];
  const lastFrozenSeq = frozenSeqs.at(-1);
  if (options.cursor.direction === "forward") {
    const requestedThrough = options.cursor.throughSeq;
    const effectiveThrough = requestedThrough ?? page.frozenSeq;
    for (const seq of frozenSeqs) {
      if (
        seq <= options.cursor.afterSeq ||
        (effectiveThrough !== null && seq > effectiveThrough)
      ) {
        failWirePage(`forward page returned out-of-range physical seq ${seq}`);
      }
    }
    if (page.nextCursor) {
      if (page.nextCursor.direction !== "forward") {
        failWirePage("forward page returned a backward continuation");
      }
      if (
        lastFrozenSeq === undefined ||
        page.nextCursor.afterSeq !== lastFrozenSeq ||
        page.nextCursor.afterSeq <= options.cursor.afterSeq
      ) {
        failWirePage("forward nextCursor does not advance to the last row");
      }
      if (
        page.nextCursor.throughSeq === undefined ||
        effectiveThrough === null ||
        page.nextCursor.throughSeq !== effectiveThrough
      ) {
        failWirePage(
          "forward nextCursor did not preserve the snapshot high-water mark"
        );
      }
    }
  } else {
    const exclusiveUpper =
      options.cursor.beforeSeq ??
      (page.frozenSeq === null ? null : page.frozenSeq + 1);
    for (const seq of frozenSeqs) {
      if (exclusiveUpper !== null && seq >= exclusiveUpper) {
        failWirePage(`backward page returned out-of-range physical seq ${seq}`);
      }
    }
    if (page.nextCursor) {
      if (page.nextCursor.direction !== "backward") {
        failWirePage("backward page returned a forward continuation");
      }
      if (
        firstFrozenSeq === undefined ||
        page.nextCursor.beforeSeq !== firstFrozenSeq
      ) {
        failWirePage(
          "backward nextCursor does not continue before the first row"
        );
      }
    }
  }

  return {
    epoch: page.epoch,
    frozenSeq: page.frozenSeq,
    tailHash: page.tailHash,
    count: page.count,
    segments: page.segments,
    tailIncluded: page.tailIncluded,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    returnedWireBytes: page.returnedWireBytes,
  };
}

/**
 * Read physical segment wires for one shared session. Legacy callers may
 * still request the paged full-snapshot-compatible response. New imports
 * pass `boundedWirePage: true`; that overload requires server pagination
 * metadata and enforces the requested row/byte budgets before returning raw
 * wires to the Rust ingester.
 *
 * With `options.shareToken` this becomes a registered-link read that does not
 * require org membership (opaque ORG2_UNAUTHORIZED on every capability
 * failure). The bounded contract requires a deployed
 * `cloud_get_session_events` that accepts direction/after/before/through and
 * max-segment/max-byte parameters; an older response fails closed.
 */
export function getSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options: GetSessionEventWirePageOptions
): Promise<CloudSessionEventWirePage>;
export function getSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSnapshot>;
export async function getSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions | GetSessionEventWirePageOptions
): Promise<CloudSessionEventsSnapshot | CloudSessionEventWirePage> {
  const boundedOptions =
    options && "boundedWirePage" in options ? options : null;
  if (boundedOptions) {
    return getSessionEventWirePage(
      accessToken,
      orgId,
      sessionId,
      boundedOptions
    );
  }
  const segments: CloudSegmentWire[] = [];
  const summary = await streamSessionEvents(
    accessToken,
    orgId,
    sessionId,
    async (page) => {
      segments.push(...page.segments);
    },
    options ?? undefined
  );
  return { ...summary, segments };
}

async function getSessionEventWirePage(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options: GetSessionEventWirePageOptions
): Promise<CloudSessionEventWirePage> {
  assertWirePageRequest(options);
  const payload = await callSyncRpc(
    "cloud_get_session_events",
    accessToken,
    {
      p_org_id: orgId,
      p_session_id: sessionId,
      ...(options.shareToken !== undefined
        ? { p_share_token: options.shareToken }
        : {}),
      p_direction: options.cursor.direction,
      ...(options.cursor.direction === "forward"
        ? {
            p_after_seq: options.cursor.afterSeq,
            ...(options.cursor.throughSeq !== undefined
              ? { p_through_seq: options.cursor.throughSeq }
              : {}),
          }
        : options.cursor.beforeSeq !== undefined
          ? { p_before_seq: options.cursor.beforeSeq }
          : {}),
      p_include_tail: options.includeTail,
      p_max_segments: options.maxSegments,
      p_max_wire_bytes: options.maxWireBytes,
    },
    options.endpoint,
    options.signal,
    undefined,
    options.maxWireBytes + CLOUD_WIRE_PAGE_RESPONSE_OVERHEAD_BYTES
  );
  return validateWirePageResponse(
    CloudSessionEventWirePageSchema.parse(payload),
    options
  );
}

/**
 * Bounded-memory variant used by large replay imports. A page is released as
 * soon as `onPage` resolves; callers must not retain it when they need a
 * genuinely streaming path.
 */
export async function streamSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  onPage: (page: CloudSessionEventsSnapshot) => Promise<void>,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSummary> {
  try {
    return await streamSessionEventsPaged(
      accessToken,
      orgId,
      sessionId,
      onPage,
      options
    );
  } catch (error) {
    if (!(error instanceof Org2CloudSyncError) || error.status !== 404) {
      throw error;
    }
    const snapshot = await getSessionEventsLegacy(
      accessToken,
      orgId,
      sessionId,
      options
    );
    await onPage(snapshot);
    const { segments: _segments, ...summary } = snapshot;
    return summary;
  }
}

async function streamSessionEventsPaged(
  accessToken: string,
  orgId: string,
  sessionId: string,
  onPage: (page: CloudSessionEventsSnapshot) => Promise<void>,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSummary> {
  let afterSeq = options?.afterSeq ?? 0;
  let expectedEpoch: number | null = null;
  let latest: CloudSessionEventsSummary = {
    epoch: null,
    frozenSeq: null,
    tailHash: null,
    count: null,
  };

  for (let pageIndex = 0; pageIndex < MAX_SESSION_EVENT_PAGES; pageIndex += 1) {
    const payload = await callSyncRpc(
      "cloud_get_session_events_page",
      accessToken,
      {
        p_org_id: orgId,
        p_session_id: sessionId,
        p_after_seq: afterSeq,
        p_limit: SESSION_EVENTS_PAGE_SIZE,
        ...(expectedEpoch !== null ? { p_expected_epoch: expectedEpoch } : {}),
        ...(options?.shareToken !== undefined
          ? { p_share_token: options.shareToken }
          : {}),
      },
      options?.endpoint,
      options?.signal
    );
    const parsed = CloudSessionEventsPageSchema.parse(payload);
    if (expectedEpoch === null) {
      expectedEpoch = parsed.epoch;
    } else if (parsed.epoch !== expectedEpoch) {
      throw new Org2CloudSyncError(
        "ORG2_CONFLICT session events epoch changed during paged read",
        409
      );
    }

    latest = {
      epoch: parsed.epoch,
      frozenSeq: parsed.frozenSeq,
      tailHash: parsed.tailHash,
      count: parsed.count,
    };
    await onPage({ ...latest, segments: parsed.segments });
    if (!parsed.hasMore) {
      return latest;
    }
    if (parsed.nextAfterSeq <= afterSeq) {
      throw new Org2CloudSyncError(
        "cloud_get_session_events_page did not advance its cursor"
      );
    }
    afterSeq = parsed.nextAfterSeq;
  }

  throw new Org2CloudSyncError(
    `cloud_get_session_events_page exceeded ${MAX_SESSION_EVENT_PAGES} pages`
  );
}

async function getSessionEventsLegacy(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSnapshot> {
  const payload = await callSyncRpc(
    "cloud_get_session_events",
    accessToken,
    {
      p_org_id: orgId,
      p_session_id: sessionId,
      ...(options?.shareToken !== undefined
        ? { p_share_token: options.shareToken }
        : {}),
      ...(options?.afterSeq !== undefined
        ? { p_after_seq: options.afterSeq }
        : {}),
    },
    options?.endpoint,
    options?.signal
  );
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
