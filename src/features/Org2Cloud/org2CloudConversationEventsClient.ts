/**
 * Managed-cloud conversation-events client for the existing Team Session
 * event plane.
 *
 * A conversation — keyed by `(orgId, rootSessionId)` — accepts turn events
 * from ANY org member, each stamped with its author. This is the wire that
 * makes "chatting in a shared session" a shared session instead of a fork:
 * the sender's machine runs the turn locally and publishes the resulting
 * normalized events here; every client merges the plane into the one
 * conversation stream.
 *
 * Wrappers follow the `org2CloudCommentsClient` idiom: raw fetch, JWT
 * Bearer + `Content-Profile: org2_cloud`, whole-token `ORG2_*` code
 * extraction, throwing typed errors. Capability-gated by
 * `getCloudCapabilities().conversationEvents`; unsupported endpoints fail
 * closed instead of silently changing the conversation identity.
 */
import { z } from "zod/v4";

import { SessionEventSchema } from "@src/engines/SessionCore/core/schemas";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";

import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";
import { sha256Hex } from "./org2CloudOrgManagement";

const log = createLogger("Org2CloudConversationEvents");

// Core's runtime schema deliberately retains forward-compatible fields with
// `catchall`; after that validation boundary the application-wide contract is
// the richer `SessionEvent` interface (for example typed extracted payloads).
const CloudSessionEventSchema = SessionEventSchema.transform(
  (event) => event as SessionEvent
);

/** RPC-enforced bounds (0024) — mirrored before the wire. */
export const CLOUD_CONVERSATION_MAX_EVENTS_PER_PUSH = 200;
export const CLOUD_CONVERSATION_MAX_EVENT_BYTES = 65536;
const CLOUD_CONVERSATION_CHUNK_DATA_BYTES = 32 * 1024;
/** Matches the native materializer's hard transcript ingress ceiling. */
export const CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES = 64 * 1024 * 1024;
const CLOUD_CONVERSATION_MAX_CHUNKS_PER_EVENT = Math.ceil(
  CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES /
    CLOUD_CONVERSATION_CHUNK_DATA_BYTES
);
const CLOUD_CONVERSATION_MAX_CHUNK_BASE64_CHARS =
  4 * Math.ceil(CLOUD_CONVERSATION_CHUNK_DATA_BYTES / 3);
const CONVERSATION_EVENT_CHUNK_FUNCTION = "conversation_event_chunk";

export const ORG2_CONVERSATION_ERROR_CODES = [
  "ORG2_VALIDATION",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_FORBIDDEN",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_CONVERSATION_BATCH_TOO_LARGE",
  "ORG2_CONVERSATION_EVENT_TOO_LARGE",
] as const;

export type Org2ConversationErrorCode =
  (typeof ORG2_CONVERSATION_ERROR_CODES)[number];

export class Org2CloudConversationError extends Error {
  readonly code: Org2ConversationErrorCode | null;
  readonly status: number | null;
  /** True only for a typed incomplete-read state that can converge later. */
  readonly recoveryPending: boolean;

  constructor(
    message: string,
    status: number | null = null,
    options: { recoveryPending?: boolean } = {}
  ) {
    super(message);
    this.name = "Org2CloudConversationError";
    this.status = status;
    this.recoveryPending = options.recoveryPending === true;
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_CONVERSATION_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ConversationErrorCode | undefined) ?? null;
  }
}

async function callConversationRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>,
  endpoint: Pick<CloudEndpoint, "supabaseUrl" | "anonKey"> = getCloudEndpoint()
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
    throw new Org2CloudConversationError(message, response.status);
  }
  return payload;
}

const CloudConversationEventWireSchema = z.object({
  id: z.string(),
  rootSessionId: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  authorAvatarUrl: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  turnId: z.string(),
  seq: z.number().int().safe().nonnegative(),
  /**
   * Normalized SessionEvent payload, rendered natively by the stream. The
   * envelope columns are server-owned and stay strict; the payload was
   * written by whichever app version pushed the turn, so rows that no longer
   * satisfy the schema are already durable and are quarantined per row
   * instead of failing the page for every reader.
   */
  event: z.unknown(),
  createdAt: z.string(),
});

export type CloudConversationEvent = Omit<
  z.output<typeof CloudConversationEventWireSchema>,
  "event"
> & { event: SessionEvent };

const ListConversationEventsWireSchema = z.object({
  events: z.array(CloudConversationEventWireSchema),
  hasMore: z.boolean(),
});

const PushConversationEventsWireSchema = z.object({
  firstSeq: z.number(),
  lastSeq: z.number(),
});

export interface ListConversationEventsResult {
  events: CloudConversationEvent[];
  hasMore: boolean;
  /** Highest wire seq in the page, quarantined rows included. */
  lastSeq: number;
  quarantined: number;
}

export async function listConversationEvents(
  accessToken: string,
  params: {
    orgId: string;
    rootSessionId: string;
    afterSeq?: number;
    limit?: number;
  },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
): Promise<ListConversationEventsResult> {
  const payload = await callConversationRpc(
    "cloud_list_conversation_events",
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_after_seq: params.afterSeq ?? 0,
      p_limit: params.limit ?? 500,
    },
    endpoint
  );
  const parsed = ListConversationEventsWireSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("unparseable conversation events listing", parsed.error);
    throw new Org2CloudConversationError(
      "unparseable cloud_list_conversation_events payload"
    );
  }
  const events: CloudConversationEvent[] = [];
  const quarantined: string[] = [];
  let lastSeq = params.afterSeq ?? 0;
  for (const row of parsed.data.events) {
    if (row.seq > lastSeq) lastSeq = row.seq;
    const event = CloudSessionEventSchema.safeParse(row.event);
    if (!event.success) {
      quarantined.push(row.id);
      continue;
    }
    events.push({ ...row, event: event.data });
  }
  if (quarantined.length > 0) {
    log.warn("quarantined non-conforming conversation rows", {
      rootSessionId: params.rootSessionId,
      count: quarantined.length,
      rowIds: quarantined.slice(0, 10),
    });
  }
  return {
    events,
    hasMore: parsed.data.hasMore,
    lastSeq,
    quarantined: quarantined.length,
  };
}

export interface PushConversationEventsResult {
  firstSeq: number;
  lastSeq: number;
}

export async function pushConversationEvents(
  accessToken: string,
  params: {
    orgId: string;
    rootSessionId: string;
    turnId: string;
    events: readonly SessionEvent[];
  },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
): Promise<PushConversationEventsResult> {
  if (params.events.length === 0) {
    throw new Org2CloudConversationError("ORG2_VALIDATION: empty batch");
  }
  if (params.events.length > CLOUD_CONVERSATION_MAX_EVENTS_PER_PUSH) {
    throw new Org2CloudConversationError("ORG2_CONVERSATION_BATCH_TOO_LARGE");
  }
  const payload = await callConversationRpc(
    "cloud_push_conversation_events",
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_events: params.events,
    },
    endpoint
  );
  const parsed = PushConversationEventsWireSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Org2CloudConversationError(
      "unparseable cloud_push_conversation_events payload"
    );
  }
  return parsed.data;
}

/**
 * Push a turn's events in RPC-sized batches under one turnId. The plane is
 * append-only per conversation, so several pushes under the same turnId are
 * one turn — a long tool-heavy turn easily exceeds the 200-event cap.
 */
export async function pushConversationEventsChunked(
  accessToken: string,
  params: {
    orgId: string;
    rootSessionId: string;
    turnId: string;
    events: readonly SessionEvent[];
  },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
): Promise<PushConversationEventsResult> {
  let result: PushConversationEventsResult | null = null;
  for (
    let offset = 0;
    offset < params.events.length;
    offset += CLOUD_CONVERSATION_MAX_EVENTS_PER_PUSH
  ) {
    result = await pushConversationEvents(
      accessToken,
      {
        ...params,
        events: params.events.slice(
          offset,
          offset + CLOUD_CONVERSATION_MAX_EVENTS_PER_PUSH
        ),
      },
      endpoint
    );
  }
  if (!result) {
    throw new Org2CloudConversationError("ORG2_VALIDATION: empty batch");
  }
  return result;
}

/**
 * Client-side mirror of the 64KB/event CHECK. A canonical conversation is a
 * native-resume source, so silently truncating text/tool/image data would
 * create a session that looks continuous while the model received incomplete
 * history. Fail closed until the transport has an exact large-payload codec.
 */
export function boundConversationEventForPush(
  event: SessionEvent
): SessionEvent {
  const size = new TextEncoder().encode(JSON.stringify(event)).length;
  if (size <= CLOUD_CONVERSATION_MAX_EVENT_BYTES) return event;
  throw new Org2CloudConversationError(
    `ORG2_CONVERSATION_EVENT_TOO_LARGE: event ${event.id} is ${size} bytes; exact native continuation requires the complete event`
  );
}

interface ConversationEventChunkMetadata {
  version: 1;
  sourceEventId: string;
  chunkIndex: number;
  chunkCount: number;
  byteLength: number;
  sha256: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  // Reject before `atob` allocates attacker-controlled output. One Cloud row
  // can contain at most one producer-sized chunk.
  if (value.length > CLOUD_CONVERSATION_MAX_CHUNK_BASE64_CHARS) {
    throw new Org2CloudConversationError(
      "conversation event chunk exceeds the encoded part limit"
    );
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Org2CloudConversationError(
      "conversation event chunk contains invalid base64"
    );
  }
  if (binary.length > CLOUD_CONVERSATION_CHUNK_DATA_BYTES) {
    throw new Org2CloudConversationError(
      "conversation event chunk exceeds the decoded part limit"
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type ConversationChunkRole =
  | { kind: "ordinary" }
  | { kind: "chunk"; metadata: ConversationEventChunkMetadata }
  | { kind: "invalid" };

interface ConversationChunkRow {
  row: CloudConversationEvent;
  metadata: ConversationEventChunkMetadata;
}

function conversationChunkRole(event: SessionEvent): ConversationChunkRole {
  if (event.functionName !== CONVERSATION_EVENT_CHUNK_FUNCTION) {
    return { kind: "ordinary" };
  }
  const value = event.args?.conversationEventChunk;
  if (!value || typeof value !== "object") return { kind: "invalid" };
  const metadata = value as Partial<ConversationEventChunkMetadata>;
  if (
    metadata.version !== 1 ||
    typeof metadata.sourceEventId !== "string" ||
    metadata.sourceEventId.length === 0 ||
    !Number.isSafeInteger(metadata.chunkIndex) ||
    !Number.isSafeInteger(metadata.chunkCount) ||
    !Number.isSafeInteger(metadata.byteLength) ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(metadata.sha256) ||
    (metadata.chunkIndex as number) < 0 ||
    (metadata.chunkCount as number) < 1 ||
    (metadata.chunkCount as number) > CLOUD_CONVERSATION_MAX_CHUNKS_PER_EVENT ||
    (metadata.chunkIndex as number) >= (metadata.chunkCount as number) ||
    (metadata.byteLength as number) < 1 ||
    (metadata.byteLength as number) > CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "chunk",
    metadata: metadata as ConversationEventChunkMetadata,
  };
}

/** Exact wire codec for events larger than the server's per-row limit. */
export async function conversationEventsForPush(
  event: SessionEvent
): Promise<SessionEvent[]> {
  try {
    return [boundConversationEventForPush(event)];
  } catch (error) {
    if (
      !(error instanceof Org2CloudConversationError) ||
      error.code !== "ORG2_CONVERSATION_EVENT_TOO_LARGE"
    ) {
      throw error;
    }
  }

  const serialized = JSON.stringify(event);
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES) {
    throw new Org2CloudConversationError(
      `ORG2_CONVERSATION_EVENT_TOO_LARGE: event ${event.id} is ${bytes.length} bytes; logical event limit is ${CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES}`
    );
  }
  const digest = await sha256Hex(serialized);
  const chunkCount = Math.ceil(
    bytes.length / CLOUD_CONVERSATION_CHUNK_DATA_BYTES
  );
  const chunks: SessionEvent[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const data = bytes.subarray(
      chunkIndex * CLOUD_CONVERSATION_CHUNK_DATA_BYTES,
      (chunkIndex + 1) * CLOUD_CONVERSATION_CHUNK_DATA_BYTES
    );
    const id = `convchunk-${digest}-${chunkIndex}`;
    chunks.push(
      boundConversationEventForPush({
        id,
        chunk_id: id,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        functionName: CONVERSATION_EVENT_CHUNK_FUNCTION,
        uiCanonical: CONVERSATION_EVENT_CHUNK_FUNCTION,
        actionType: "raw",
        args: {
          conversationEventChunk: {
            version: 1,
            sourceEventId: event.id,
            chunkIndex,
            chunkCount,
            byteLength: bytes.length,
            sha256: digest,
          } satisfies ConversationEventChunkMetadata,
        },
        result: { data: bytesToBase64(data) },
        source: "system",
        displayText: "",
        displayStatus: "completed",
        displayVariant: "message",
        activityStatus: "processed",
        payloadRefs: [],
      } as SessionEvent)
    );
  }
  return chunks;
}

/** Reassemble and SHA-256 verify complete chunk groups before projection. */
export async function decodeConversationEventChunks(
  rows: readonly CloudConversationEvent[]
): Promise<CloudConversationEvent[]> {
  const ordinary: CloudConversationEvent[] = [];
  const groups = new Map<string, ConversationChunkRow[]>();
  const quarantined: string[] = [];
  for (const row of rows) {
    const role = conversationChunkRole(row.event);
    if (role.kind === "ordinary") {
      ordinary.push(row);
      continue;
    }
    if (role.kind === "invalid") {
      quarantined.push(row.id);
      continue;
    }
    const metadata = role.metadata;
    const key = `${row.rootSessionId}\u001f${row.turnId}\u001f${metadata.sourceEventId}`;
    const group = groups.get(key) ?? [];
    group.push({ row, metadata });
    groups.set(key, group);
  }
  if (quarantined.length > 0) {
    log.warn("quarantined malformed conversation event chunk rows", {
      count: quarantined.length,
      rowIds: quarantined.slice(0, 10),
    });
  }
  for (const group of groups.values()) {
    const first = group[0];
    const firstMetadata = first.metadata;
    if (
      group.some(
        ({ row, metadata }) =>
          row.rootSessionId !== first.row.rootSessionId ||
          row.turnId !== first.row.turnId ||
          metadata.sourceEventId !== firstMetadata.sourceEventId ||
          metadata.sha256 !== firstMetadata.sha256 ||
          metadata.chunkCount !== firstMetadata.chunkCount ||
          metadata.byteLength !== firstMetadata.byteLength
      )
    ) {
      throw new Org2CloudConversationError(
        `inconsistent conversation event chunk metadata for ${firstMetadata.sourceEventId}`
      );
    }
    if (group.length !== firstMetadata.chunkCount) {
      throw new Org2CloudConversationError(
        `incomplete conversation event ${firstMetadata.sourceEventId}: ${group.length}/${firstMetadata.chunkCount} chunks`,
        null,
        { recoveryPending: true }
      );
    }
    const indices = new Set(group.map(({ metadata }) => metadata.chunkIndex));
    // Every index was range-checked above. With exactly `chunkCount` rows,
    // `chunkCount` unique values therefore proves the exact 0..n-1 set.
    if (indices.size !== firstMetadata.chunkCount) {
      throw new Org2CloudConversationError(
        `conversation event ${firstMetadata.sourceEventId} has duplicate or missing chunk indices`
      );
    }
    const ordered = [...group].sort(
      (left, right) => left.metadata.chunkIndex - right.metadata.chunkIndex
    );
    let accumulatedBytes = 0;
    const parts = ordered.map(({ row }) => {
      const data = (row.event.result as { data?: unknown } | undefined)?.data;
      if (typeof data !== "string") {
        throw new Org2CloudConversationError(
          "invalid conversation event chunk"
        );
      }
      const part = base64ToBytes(data);
      accumulatedBytes += part.length;
      if (
        accumulatedBytes > firstMetadata.byteLength ||
        accumulatedBytes > CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES
      ) {
        throw new Org2CloudConversationError(
          `conversation event ${firstMetadata.sourceEventId} exceeds its declared byte length`
        );
      }
      return part;
    });
    const byteLength = parts.reduce((total, part) => total + part.length, 0);
    if (byteLength !== firstMetadata.byteLength) {
      throw new Org2CloudConversationError(
        `conversation event ${firstMetadata.sourceEventId} byte length mismatch`
      );
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const serialized = new TextDecoder().decode(bytes);
    if ((await sha256Hex(serialized)) !== firstMetadata.sha256) {
      throw new Org2CloudConversationError(
        `conversation event ${firstMetadata.sourceEventId} digest mismatch`
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch {
      throw new Org2CloudConversationError(
        `conversation event ${firstMetadata.sourceEventId} contains invalid JSON`
      );
    }
    const parsedEvent = CloudSessionEventSchema.safeParse(decoded);
    if (!parsedEvent.success) {
      throw new Org2CloudConversationError(
        `conversation event ${firstMetadata.sourceEventId} contains an invalid SessionEvent`
      );
    }
    const event = parsedEvent.data;
    if (event.id !== firstMetadata.sourceEventId) {
      throw new Org2CloudConversationError(
        "conversation event chunk source identity mismatch"
      );
    }
    const last = ordered[ordered.length - 1].row;
    ordinary.push({ ...last, id: event.id, event });
  }
  return ordinary.sort((left, right) => left.seq - right.seq);
}
