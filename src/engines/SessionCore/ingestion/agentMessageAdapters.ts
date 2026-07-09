/**
 * Agent Message Adapters
 *
 * Shared converters for transforming agent WebSocket messages
 * (AgentMessage) into SessionEvents.
 *
 * Used by both the OS and SDE agent adapters to
 * eliminate duplicate conversion logic.
 */
import { convertFileSrc } from "@tauri-apps/api/core";

import { rpc } from "@src/api/tauri/rpc";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";

import { parseJsonRecord, parseJsonStringArray } from "../core/schemas";
import type {
  ActivityStatus,
  EventDisplayStatus,
  EventDisplayVariant,
  SessionEvent,
} from "../core/types";

// ============================================
// Base agent message shape (compatible with AgentMessage from shared/types)
// ============================================

export interface AgentMessageBase {
  id: string;
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  streaming?: boolean;
}

// ============================================
// Persisted message shape (from *_load_messages Tauri commands)
// ============================================

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  model: string | null;
  sequence: number;
  createdAt: string;
  images: string | null;
  /**
   * Set on compact-boundary rows: sequence number the preserved tail starts
   * at. Serialized by Rust's `AgentMessageRow` (serde camelCase); non-null
   * marks the row as a compaction summary rather than a normal message.
   */
  compactFromSequence?: number | null;
  compactTokensBefore?: number | null;
  compactTokensAfter?: number | null;
}

// ============================================
// Converters
// ============================================

export function getDisplayVariant(
  role: AgentMessageBase["role"]
): EventDisplayVariant {
  switch (role) {
    case "tool_call":
    case "tool_result":
      return "tool_call";
    default:
      return "message";
  }
}

export function getActivityStatus(
  role: AgentMessageBase["role"]
): ActivityStatus {
  switch (role) {
    case "tool_call":
      return "agent";
    case "tool_result":
      return "processed";
    default:
      return "agent";
  }
}

export function getDisplayStatus(msg: AgentMessageBase): EventDisplayStatus {
  if (msg.streaming) return "running";
  if (msg.role === "system" && msg.content.startsWith("Error:"))
    return "failed";
  return "completed";
}

export function buildResult(msg: AgentMessageBase): Record<string, unknown> {
  switch (msg.role) {
    case "user":
      return {
        type: "user",
        message: { content: msg.content, role: "user" },
      };
    case "assistant":
      return { observation: msg.content };
    case "tool_call":
      return {};
    case "tool_result":
      return { content: msg.content, observation: msg.content };
    case "system":
      return { observation: msg.content };
    default:
      return {};
  }
}

// ============================================
// Compact boundary parsing
// ============================================

/**
 * Continuation instruction the Rust compactor appends to every compaction
 * summary. Mirrors `COMPACT_CONTINUATION_SUFFIX` in
 * `src-tauri/crates/agent-core/src/core/model_context/compaction.rs` — keep
 * the literals in sync. Stripped from the summary before display: it is
 * model-facing steering, not user-facing content.
 */
export const COMPACT_CONTINUATION_SUFFIX =
  "This session is being continued from an earlier conversation that exceeded the context window; the older messages were compacted into the summary above. Resume the work directly from this state — do not acknowledge this summary, do not re-describe it to the user, and do not ask questions it already answers. Continue with the last task you were working on, following the user's most recent instructions.";

/**
 * Header prefixes written by the Rust compactors (LLM compact and Session
 * Memory compact). Mirror `LLM_COMPACT_BOUNDARY_PREFIX` /
 * `SM_COMPACT_BOUNDARY_PREFIX` in
 * `src-tauri/crates/agent-core/src/core/model_context/session_memory/compact.rs`
 * (prefix match stops before the dash so both the em-dash and the legacy
 * hyphen "compacted without summary" marker are covered).
 */
const COMPACT_BOUNDARY_PREFIXES = [
  "[Conversation summary ",
  "[Session Memory ",
] as const;

export interface ParsedCompactBoundary {
  /** Header line, e.g. `[Conversation summary — 12 earlier messages compacted]`. */
  header: string | null;
  /** Summary body with the header line and continuation suffix stripped. */
  body: string;
  /** `N` parsed from the header, when present. */
  compactedCount: number | null;
}

/** True when a persisted row's content carries a compact-boundary header. */
export function isCompactBoundaryContent(content: string): boolean {
  return COMPACT_BOUNDARY_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Split a persisted compact-boundary row into header line and summary body,
 * stripping the model-facing continuation instructions.
 */
export function parseCompactBoundaryContent(
  content: string
): ParsedCompactBoundary {
  let text = content;
  const suffixIndex = text.indexOf(COMPACT_CONTINUATION_SUFFIX);
  if (suffixIndex !== -1) {
    text = text.slice(0, suffixIndex).trimEnd();
  }

  let header: string | null = null;
  let body = text.trim();
  if (isCompactBoundaryContent(text)) {
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex === -1) {
      header = text.trim();
      body = "";
    } else {
      header = text.slice(0, newlineIndex).trim();
      body = text.slice(newlineIndex + 1).trim();
    }
  }

  const countMatch = header?.match(/(\d+)\s+earlier messages compacted\]/);
  const compactedCount = countMatch ? Number(countMatch[1]) : null;

  return { header, body, compactedCount };
}

/**
 * Convert a compact-boundary row into a SessionEvent routed to the dedicated
 * `context_compacted` renderer.
 *
 * Mirrors `makeRateLimitHintEvent` (shared/eventFactories.ts): neutral
 * `actionType`/`source` keep the row out of the assistant-prose heuristics in
 * ActivityRouter/willEventRenderContent, and `displayVariant` stays a
 * wire-safe value — SessionEvents round-trip through Rust
 * (`es_merge_tool_results`, event store), whose `EventDisplayVariant` serde
 * enum rejects unknown variants. Component routing happens via `uiCanonical`.
 */
export function compactBoundaryToSessionEvent(
  msg: PersistedMessage,
  sessionId: string
): SessionEvent {
  const { header, body, compactedCount } = parseCompactBoundaryContent(
    msg.content
  );
  const functionName = "context_compacted";
  return {
    id: msg.id,
    chunk_id: msg.id,
    sessionId,
    createdAt: msg.createdAt,
    functionName,
    uiCanonical: normalizeFunctionName(functionName),
    actionType: "system",
    args: {},
    result: {
      observation: body,
      ...(header !== null ? { header } : {}),
      ...(compactedCount !== null ? { compactedCount } : {}),
      ...(msg.compactTokensBefore != null && msg.compactTokensAfter != null
        ? {
            tokensBefore: msg.compactTokensBefore,
            tokensAfter: msg.compactTokensAfter,
          }
        : {}),
    },
    source: "system",
    // Fall back to the header line when the summary body is empty (legacy
    // "compacted without summary" markers) so willEventRenderContent still
    // lets the collapsed marker through.
    displayText: body || (header ?? ""),
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

/**
 * Convert persisted DB messages to SessionEvents.
 *
 * @param options.transformDisplayText - Optional transform for displayText
 */
export function persistedMessageToSessionEvent(
  msg: PersistedMessage,
  sessionId: string,
  options?: {
    transformDisplayText?: (content: string, source: string) => string;
  }
): SessionEvent {
  // Compact-boundary rows get a dedicated collapsed renderer instead of
  // rendering the raw summary + continuation instructions as assistant
  // prose. `compactFromSequence` is authoritative; the content-prefix check
  // covers rows persisted before the column existed.
  if (
    msg.compactFromSequence != null ||
    (msg.role === "system" && isCompactBoundaryContent(msg.content))
  ) {
    return compactBoundaryToSessionEvent(msg, sessionId);
  }

  const actionType =
    msg.role === "tool_call"
      ? "tool_call"
      : msg.role === "tool_result"
        ? "tool_result"
        : msg.role === "user"
          ? "raw"
          : "assistant";

  const source: "user" | "assistant" =
    msg.role === "user" ? "user" : "assistant";

  let result: Record<string, unknown> = {};
  if (msg.role === "user") {
    const displayImages = parseActivityImages(msg.images);
    result = {
      type: "user",
      message: { content: msg.content, role: "user" },
      ...(displayImages && displayImages.length > 0
        ? { images: displayImages }
        : {}),
    };
  } else if (msg.role === "assistant") {
    result = { observation: msg.content };
  } else if (msg.role === "tool_result") {
    result = {
      content: msg.toolOutput ?? msg.content,
      observation: msg.toolOutput ?? msg.content,
    };
  }

  let args: Record<string, unknown> = {};
  if (msg.toolInput) {
    try {
      args = parseJsonRecord(msg.toolInput);
    } catch {
      args = { raw: msg.toolInput };
    }
  }

  const displayText = options?.transformDisplayText
    ? options.transformDisplayText(msg.content, source)
    : msg.content;

  const functionName =
    msg.toolName ?? (msg.role === "user" ? "user_input" : "assistant_message");

  return {
    id: msg.id,
    chunk_id: msg.id,
    sessionId,
    createdAt: msg.createdAt,
    functionName,
    uiCanonical: normalizeFunctionName(functionName),
    actionType,
    args,
    result,
    source,
    displayText,
    displayStatus: "completed",
    displayVariant: getDisplayVariant(msg.role as AgentMessageBase["role"]),
    activityStatus: getActivityStatus(msg.role as AgentMessageBase["role"]),
    callId: msg.toolCallId ?? undefined,
    isDelta: false,
  };
}

// ============================================
// Merge tool_results into tool_calls
// ============================================

/**
 * Merge tool_result events into their matching tool_call events via Rust.
 * Uses O(1) HashMap lookup instead of O(n) findIndex.
 */
export async function mergeToolResults(
  events: SessionEvent[]
): Promise<SessionEvent[]> {
  if (events.length === 0) return events;
  return rpc.sessionCore.eventStore.mergeToolResults({ events });
}

// ============================================
// Image conversion
// ============================================

/**
 * Parse and convert image references from persisted messages.
 * Handles both data: URLs and file paths (via Tauri's convertFileSrc).
 */
export function parseActivityImages(
  imagesJson: string | null
): string[] | undefined {
  if (!imagesJson) return undefined;
  try {
    const rawRefs = parseJsonStringArray(imagesJson);
    return rawRefs.map((ref) =>
      ref.startsWith("data:") ? ref : convertFileSrc(ref)
    );
  } catch {
    return undefined;
  }
}

/**
 * Convert Tauri asset:// display URLs back to absolute file paths that the
 * Rust backend can open directly.
 *
 * Tauri encodes on-disk paths as:
 *   macOS/Linux: `asset://localhost/<absolute-path>`
 *   Windows:     `https://asset.localhost/<absolute-path>`
 *
 * data: URLs and plain file paths are returned unchanged.
 */
export function imageRefToRustPath(ref: string): string {
  if (ref.startsWith("data:")) return ref;
  const ASSET_PREFIXES = ["asset://localhost", "https://asset.localhost"];
  for (const prefix of ASSET_PREFIXES) {
    if (ref.startsWith(prefix)) {
      return decodeURIComponent(ref.slice(prefix.length));
    }
  }
  return ref;
}
