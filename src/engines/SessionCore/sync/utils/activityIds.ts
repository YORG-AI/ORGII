/**
 * Activity ID Utilities
 *
 * Centralized ID generation and parsing for activity/chat items.
 * Provides consistent, predictable IDs across the codebase.
 *
 * ID Format: {prefix}:{source}:{identifier}
 * Examples:
 *   - chunk:api:abc123-def456         (from API)
 *   - merged:thinking:abc123          (merged thinking chunks)
 *   - stream-think-session-id         (streaming thinking - Rust format)
 *   - stream-msg-session-id           (streaming message - Rust format)
 *   - group:readfile:abc123           (read file group)
 *   - group:task:abc123               (task group)
 *   - header:stage:execution:abc123   (stage header)
 */

// ============================================
// ID Prefixes (Type Constants)
// ============================================

export const ID_PREFIX = {
  /** Original chunk from API */
  CHUNK: "chunk",
  /** Merged/consolidated item */
  MERGED: "merged",
  /** Streaming item (in progress) */
  STREAM: "stream",
  /** Grouped items */
  GROUP: "group",
  /** UI elements (headers, etc.) */
  HEADER: "header",
  /**
   * Synthetic user input event (injected by frontend before backend echo).
   * Used to distinguish frontend-generated events from real backend events.
   */
  USER_INPUT: "user-input-",
} as const;

export const ID_SOURCE = {
  /** From backend API */
  API: "api",
  /** Thinking/reasoning content */
  THINKING: "thinking",
  /** Assistant message */
  MESSAGE: "message",
  /** Read file activities */
  READFILE: "readfile",
  /** Action summary (grouped exploration tool calls) */
  ACTION_SUMMARY: "actionsummary",
  /** Task activities */
  TASK: "task",
  /** Stage header */
  STAGE: "stage",
  /** Tool call */
  TOOL: "tool",
} as const;

interface UserEventIdentityFields {
  source: string;
  functionName: string;
  uiCanonical: string;
  chunk_id?: string | null;
  result?: Record<string, unknown>;
}

export function isSyntheticUserInputEvent(
  event: UserEventIdentityFields
): boolean {
  return (
    event.source === "user" &&
    event.functionName === "user_message" &&
    event.result?.syntheticUserInput === true
  );
}

export function isBackendUserMessageEvent(
  event: UserEventIdentityFields
): boolean {
  // Backend user turns arrive under two names: live-runner broadcasts
  // normalize to functionName "user" (see loadSessionAtom's identity notes),
  // while transcript replay/imported loaders emit "user_message".
  return (
    event.source === "user" &&
    (event.functionName === "user" || event.functionName === "user_message") &&
    !isSyntheticUserInputEvent(event)
  );
}

// ============================================
// ID Generation Functions
// ============================================

/**
 * Generate ID for a chunk from API
 * @param chunkId - Original chunk_id from backend
 */
export function createChunkId(chunkId: string): string {
  return `${ID_PREFIX.CHUNK}:${ID_SOURCE.API}:${chunkId}`;
}

/**
 * Generate ID for merged thinking chunks
 * @param firstChunkId - The first chunk's ID that was merged
 */
export function createMergedThinkingId(firstChunkId: string): string {
  return `${ID_PREFIX.MERGED}:${ID_SOURCE.THINKING}:${firstChunkId}`;
}

/**
 * Monotonic nonce for the TS-side streaming placeholder ids.
 *
 * A bare `Date.now()` nonce is NOT unique: two placeholders minted for the
 * same session inside one millisecond get byte-identical ids, and the event
 * store UPSERTs on id — so the second stream overwrites the first stream's
 * row instead of creating its own, merging two logically distinct streams
 * into one transcript event. A fast `reset()` → next-delta sequence hits this
 * routinely. Rust solved the same hazard the same way for its authoritative
 * ids (see `foundation/streaming.rs::stream_event_id`, whose `segment_counters`
 * comment describes the identical upsert-overwrite failure).
 *
 * Shared by both lanes and never reset, so uniqueness does not depend on the
 * wall clock moving forward — a clock that stalls, or steps backwards across a
 * DST/NTP adjustment, still yields distinct ids.
 */
let streamPlaceholderSeq = 0;

/**
 * Zero-padded so ids sort lexicographically in creation order.
 *
 * `compareChatEvents` (core/store/snapshotMaterialization.orderMembership)
 * breaks `createdAt` ties with `id.localeCompare`, and two same-millisecond
 * placeholders routinely share a `createdAt`. Unpadded, "…-10" would sort
 * before "…-2". Past 999_999 nonces in one process the width grows and that
 * tie-break ordering degrades; uniqueness is unaffected.
 */
function nextStreamPlaceholderNonce(): string {
  streamPlaceholderSeq += 1;
  return String(streamPlaceholderSeq).padStart(6, "0");
}

/**
 * Generate a per-turn unique ID for the TS-side streaming thinking placeholder.
 *
 * Uses a timestamp plus a monotonic counter so the placeholder never collides
 * with the previous turn's completed thinking event — nor with another
 * placeholder minted in the same millisecond. When `agent:streaming_complete`
 * arrives, the caller is responsible for removing this placeholder and
 * inserting Rust's authoritative event (ID = `stream-think-{sessionId}`).
 *
 * The `stream-think-ts-` prefix is load-bearing: Rust filters these live-only
 * rows out of persistence by prefix (`session-persistence/src/crud.rs::
 * is_ts_placeholder_id`, `subagent_handler/persistence.rs`), and the e2e suite
 * uses it to tell TS placeholders from Rust's authoritative `stream-think-`
 * events. The id must also stay colon-free so `parseActivityId` keeps
 * classifying it as an opaque legacy id rather than a `prefix:source:id`
 * triple (same constraint as `TeamCollaboration/copyEventId.ts`).
 *
 * @param sessionId - Current session ID
 */
export function createStreamThinkingId(sessionId: string): string {
  return `stream-think-ts-${sessionId}-${Date.now()}-${nextStreamPlaceholderNonce()}`;
}

/**
 * Generate a per-turn unique ID for the TS-side streaming message placeholder.
 *
 * Uses a timestamp plus a monotonic counter so the placeholder never collides
 * with the previous turn's completed assistant message — nor with another
 * placeholder minted in the same millisecond. When `agent:streaming_complete`
 * arrives, the caller is responsible for removing this placeholder and
 * inserting Rust's authoritative event (ID = `stream-msg-{sessionId}`).
 *
 * See `createStreamThinkingId` for why the `stream-msg-ts-` prefix and the
 * colon-free shape are load-bearing.
 *
 * @param sessionId - Current session ID
 */
export function createStreamMessageId(sessionId: string): string {
  return `stream-msg-ts-${sessionId}-${Date.now()}-${nextStreamPlaceholderNonce()}`;
}

/**
 * Generate ID for a read file group
 * @param firstChunkId - First read file chunk's ID
 */
export function createReadFileGroupId(firstChunkId: string): string {
  return `${ID_PREFIX.GROUP}:${ID_SOURCE.READFILE}:${firstChunkId}`;
}

/**
 * Generate ID for an action summary group (consecutive exploration tool calls)
 * @param firstChunkId - First activity's chunk ID
 */
export function createActionSummaryGroupId(firstChunkId: string): string {
  return `${ID_PREFIX.GROUP}:${ID_SOURCE.ACTION_SUMMARY}:${firstChunkId}`;
}

/**
 * Generate ID for a task group
 * @param firstMsgId - First task's msg_id
 */
export function createTaskGroupId(firstMsgId: string): string {
  return `${ID_PREFIX.GROUP}:${ID_SOURCE.TASK}:${firstMsgId}`;
}

/**
 * Generate ID for an activity stack group (consecutive same-category blocks)
 * @param category - Category name (e.g. "browser", "terminal")
 * @param firstChunkId - First activity's chunk ID
 */
export function createActivityStackGroupId(
  category: string,
  firstChunkId: string
): string {
  return `${ID_PREFIX.GROUP}:stack:${category}:${firstChunkId}`;
}

/**
 * Generate ID for merged tool call
 * @param startChunkId - The start chunk's ID
 */
export function createMergedToolCallId(startChunkId: string): string {
  return `${ID_PREFIX.MERGED}:${ID_SOURCE.TOOL}:${startChunkId}`;
}

// ============================================
// ID Parsing Functions
// ============================================

export interface ParsedId {
  prefix: string;
  source: string;
  identifier: string;
  /** Additional parts after the main identifier */
  extra?: string[];
  /** Whether this is a valid activity ID format */
  isValid: boolean;
}

/**
 * Parse an activity ID into its components
 * @param id - The ID to parse
 */
export function parseActivityId(id: string): ParsedId {
  const parts = id.split(":");

  if (parts.length < 3) {
    // Legacy ID format (no prefix) - treat as chunk:api:id
    return {
      prefix: ID_PREFIX.CHUNK,
      source: ID_SOURCE.API,
      identifier: id,
      isValid: false,
    };
  }

  const [prefix, source, identifier, ...extra] = parts;

  return {
    prefix,
    source,
    identifier,
    extra: extra.length > 0 ? extra : undefined,
    isValid: true,
  };
}

/**
 * Check if an ID is a streaming ID (in progress).
 * Recognizes both legacy format (stream:...) and Rust format (stream-msg-/stream-think-).
 */
export function isStreamingId(id: string): boolean {
  return (
    id.startsWith(`${ID_PREFIX.STREAM}:`) ||
    id.startsWith("stream-msg-") ||
    id.startsWith("stream-think-")
  );
}

/**
 * Check if an ID is a merged ID
 */
export function isMergedId(id: string): boolean {
  return id.startsWith(`${ID_PREFIX.MERGED}:`);
}

/**
 * Check if an ID is a group ID
 */
export function isGroupId(id: string): boolean {
  return id.startsWith(`${ID_PREFIX.GROUP}:`);
}

/**
 * Check if an ID is a header ID
 */
export function isHeaderId(id: string): boolean {
  return id.startsWith(`${ID_PREFIX.HEADER}:`);
}

/**
 * Check if an ID is an original chunk ID from API
 */
export function isApiChunkId(id: string): boolean {
  return (
    id.startsWith(`${ID_PREFIX.CHUNK}:${ID_SOURCE.API}:`) ||
    // Legacy format: no prefix, just UUID
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}

/**
 * Extract the original chunk ID from any activity ID
 * Useful for deduplication when comparing new and old format IDs
 */
export function extractOriginalChunkId(id: string): string {
  const parsed = parseActivityId(id);

  if (!parsed.isValid) {
    // Legacy format - return as-is
    return id;
  }

  // For merged/group IDs, the identifier is the original chunk ID
  return parsed.identifier;
}

// ============================================
// Unified ID Getters (Unified ID access layer)
// ============================================

/**
 * ID field explanation (after unification):
 *
 * All data structures now use chunk_id as the unique identifier:
 *
 * | Data Structure      | ID Field    | Description                                 |
 * |---------------------|-------------|---------------------------------------------|
 * | ActivityChunk       | chunk_id    | Original backend API ID                     |
 * | OptimizedChatItem   | chunk_id    | Pipeline list key (from SessionEvent.id)    |
 * | SessionEvent        | id          | Canonical event id (same as backend chunk)  |
 * | BackendEvent        | chunk_id    | Used by Simulator event system              |
 *
 * Use getItemId() to extract chunk_id from any type.
 */

/** Object type that may contain an ID */
interface IdHolder {
  chunk_id?: string;
  event?: { id: string };
  id?: string | number;
}

/**
 * Extract chunk_id from any object (unified entrypoint)
 *
 * Primary id sources:
 * - OptimizedChatItem.chunk_id (aligned with SessionEvent.id)
 * - BackendEvent.chunk_id
 * - SessionEvent.id
 *
 * @param item - Any object that may contain an ID
 * @param fallback - Default value if no ID is found
 * @returns The extracted chunk_id or the fallback value
 *
 * @example
 * getItemId(optimizedItem) // returns optimizedItem.chunk_id
 * getItemId(backendEvent)  // returns backendEvent.chunk_id
 * getItemId(sessionEvent)  // returns sessionEvent.id
 */
export function getItemId(
  item: IdHolder | null | undefined,
  fallback = ""
): string {
  if (!item) return fallback;

  // Direct chunk_id
  if (item.chunk_id) return item.chunk_id;

  // From event reference
  if (item.event?.id) return item.event.id;

  // Generic id (fallback)
  if (item.id != null) return String(item.id);

  return fallback;
}

/**
 * Compare whether the IDs of two objects are the same
 */
export function isSameId(
  itemA: IdHolder | null | undefined,
  itemB: IdHolder | null | undefined
): boolean {
  const idA = getItemId(itemA);
  const idB = getItemId(itemB);

  if (!idA || !idB) return false;

  // Direct comparison
  if (idA === idB) return true;

  // Try to extract and compare original chunk_id (handles merged/group/stream etc.)
  const originalA = extractOriginalChunkId(idA);
  const originalB = extractOriginalChunkId(idB);

  return originalA === originalB;
}

/**
 * Check whether a given ID matches an object
 */
export function matchesId(
  item: IdHolder | null | undefined,
  targetId: string
): boolean {
  const itemId = getItemId(item);
  if (!itemId || !targetId) return false;

  if (itemId === targetId) return true;

  // Try to extract and compare original chunk_id
  return extractOriginalChunkId(itemId) === extractOriginalChunkId(targetId);
}
