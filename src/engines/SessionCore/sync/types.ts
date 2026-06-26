/**
 * Unified Session Sync — Core Types
 *
 * Defines the adapter interface that each session type (SDE Agent, OS Agent,
 * CLI, Cursor IDE) must implement. Adapters encapsulate type-specific logic:
 * - How to load persisted history from Tauri SQLite
 * - How to normalize real-time events from Tauri IPC Channels
 * - How to run post-load setup (status restoration, token counts)
 * - How to **send a new prompt** (`sendMessage`) — the dispatch the
 *   `SessionService` used to switch on session-id type lives here now.
 *   Adding a new IDE (Trae, Windsurf, …) is a new file under
 *   `adapters/`, not another `if` branch in `SessionService`.
 *
 * The unified sync hook (`useSessionSync`) uses these adapters to handle
 * all session types through a single code path.
 */
import type { CancelReason } from "@src/api/tauri/agent/session";
import { createLogger } from "@src/hooks/logger";
import type { WorkspaceSnapshot } from "@src/services/context/workspaceSnapshot";
import type { ContextUsageSnapshot } from "@src/store/session/cliSessionStatusAtom";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
  isExternalHistorySession,
} from "@src/util/session/sessionDispatch";

import type { SessionEvent } from "../core/types";

const log = createLogger("SessionCore");

// ============================================================================
// Raw event from Tauri Channel / WebSocket
// ============================================================================

/**
 * Raw event payload received from the Tauri IPC Channel.
 * This is the JSON-parsed message before adapter normalization.
 * Shape varies by session type — adapters handle the specifics.
 */
export interface RawSessionEvent {
  type: string;
  session_id?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================================================
// Post-load result
// ============================================================================

/**
 * Metadata returned by adapter.postLoad for type-specific atom updates.
 * Field names are session-type agnostic (not CLI-specific).
 */
export interface PostLoadResult {
  /** Context token fill level (sets sessionContextTokensAtom). */
  contextTokens?: number;
  /** Full context usage snapshot (sets sessionContextUsageAtom). */
  contextUsage?: ContextUsageSnapshot;
  /** Session engine run status (sets sessionRuntimeStatusAtom). */
  runStatus?: string;
  /** Session error message (sets sessionRuntimeErrorAtom). */
  runError?: string | null;
}

// ============================================================================
// Session Event Handler (stateful, per-session)
// ============================================================================

/**
 * Callbacks provided to the event handler for side effects that must reach
 * React state or dispatch window events.
 */
export interface EventHandlerCallbacks {
  /** Called when the agent completes (streaming ends). */
  onAgentComplete?: (tokenUsage?: AgentTokenUsageInfo) => void;
  /** Called when live context usage accounting updates. */
  onContextUsage?: (contextUsage: AgentContextUsageInfo) => void;
  /** Called when a permission request arrives (SDE only). */
  onPermissionRequest?: (event: PermissionRequestInfo) => void;
  /** Called when a question request arrives. */
  onQuestionRequest?: (event: QuestionRequestInfo) => void;
  /** Called on streaming delta for crash recovery. */
  onStreamingDelta?: (info: StreamingDeltaInfo) => void;
  /** Called when CLI/session status changes. Rust turn-completed includes turn metadata. */
  onStatusChange?: (
    status: string,
    error?: string,
    meta?: { turnId?: string; turnStatus?: string; intermediate?: boolean }
  ) => void;
  /** Called when CLI token usage updates. */
  onTokenUpdate?: (tokens: number) => void;
}

/**
 * A session-scoped event handler that holds mutable streaming state.
 * Created by `adapter.createEventHandler()` and disposed on session switch.
 *
 * Handlers write directly to `eventStore` — the streaming content buffers,
 * subagent tracking maps, and exec output buffers are too complex and
 * performance-sensitive to mediate through a pure action layer.
 */
export interface SessionEventHandler {
  /** Process a raw event from the Tauri Channel. */
  handleEvent(raw: RawSessionEvent): void;

  /** Reset all streaming state (on session switch or cleanup). */
  reset(): void;

  /** Whether the handler is currently in a streaming state. */
  readonly isStreaming: boolean;

  /** Release resources. */
  dispose(): void;
}

// ============================================================================
// Session Adapter
// ============================================================================

/**
 * Input passed to {@link SessionAdapter.sendMessage}. Mirrors the
 * caller's `SessionSendMessageParams` plus the ADE context snapshot
 * that `SessionService` collects up-front so each adapter doesn't
 * have to know about the ADE-context plumbing.
 *
 * Adapters that don't care about a field (Cursor IDE has its own
 * IDE context, doesn't need ours; OS Agent ignores `mode`) just
 * drop it on the floor.
 */
export interface AdapterSendInput {
  sessionId: string;
  content: string;
  /**
   * Pill-format display text from the frontend composer (e.g.
   * `"create-skill [skill:/create-skill]"`). When set, the backend stores
   * this as the event's display_text so that re-editing a historical message
   * re-populates the pill rather than the expanded YAML / skill content.
   */
  displayText?: string;
  /** Optional model override (mid-session model swap). */
  model?: string;
  /** Optional own-key account id. */
  accountId?: string;
  /** Optional agent exec mode (build/plan/explore/...). */
  mode?: string;
  /** ADE context collected by `collectAdeContext()` before dispatch. */
  adeContext?: WorkspaceSnapshot;
  /** Base64 image data URLs attached to this message. */
  imageDataUrls?: string[];
  /** Client-side idempotency key used to suppress duplicate sends. */
  clientMessageId?: string;
  /**
   * Canonical user-intent id minted at the FE submit boundary. See
   * `QueuedMessage.turnIntentId` for the propagation contract.
   */
  turnIntentId?: string;
  /**
   * When `true`, this is a user-initiated Resume after a failed turn.
   * The backend runs deletion-based orphan tool-use filter instead of
   * injecting a synthetic continuation user message.
   */
  isResume?: boolean;
  /**
   * The session row's persisted workspace root path.
   * Passed to agent adapters so they can gate ADE context on the correct repo.
   */
  sessionRepoPath?: string | null;
}

/**
 * Adapter interface for session-type-specific logic.
 * Each session type (SDE Agent, OS Agent, CLI, Cursor IDE) implements this.
 */
export interface SessionAdapter {
  /** Which session category this adapter handles. */
  readonly category: string;

  /**
   * Load persisted history from Tauri SQLite → SessionEvent[].
   * Pure async function — no side effects.
   */
  loadHistory(sessionId: string, signal: AbortSignal): Promise<SessionEvent[]>;

  /**
   * Post-load setup: restore session status, token counts, etc.
   * Returns metadata for the unified hook to apply to global atoms.
   */
  postLoad?(sessionId: string, signal: AbortSignal): Promise<PostLoadResult>;

  /**
   * Create a session-scoped event handler with mutable streaming state.
   * Each session gets its own handler instance.
   */
  createEventHandler(
    sessionId: string,
    callbacks: EventHandlerCallbacks
  ): SessionEventHandler;

  /**
   * Send a new prompt to the running session. This is the only path
   * `SessionService.sendMessage` uses to dispatch — replacing the
   * previous switch on `isAgentSession` / `isCliSession`. New IDE
   * adapters slot in here without touching `SessionService`.
   */
  sendMessage(input: AdapterSendInput): Promise<void>;

  /** Stop the running agent/session with an explicit control-flow reason. */
  stopSession(sessionId: string, reason: CancelReason): Promise<void>;
}

// ============================================================================
// Shared info types (used by callbacks)
// ============================================================================

export type AgentContextUsageCategory =
  | "stable_prompt"
  | "dynamic_prompt"
  | "rules"
  | "skills"
  | "memory"
  | "conversation"
  | "tool_results"
  | "attachments"
  | "other"
  | "unattributed";

export interface AgentContextUsageItemInfo {
  category: AgentContextUsageCategory;
  label: string;
  source: string;
  estimatedTokens: number;
  included: boolean;
  cacheStatus?: string | null;
  details?: string | null;
}

export interface AgentContextUsageSectionInfo {
  category: AgentContextUsageCategory;
  label: string;
  estimatedTokens: number;
  percent: number;
  items: AgentContextUsageItemInfo[];
}

export interface AgentContextUsageInfo {
  usedTokens: number;
  maxTokens?: number | null;
  percentUsed?: number | null;
  updatedAt: string;
  sections: AgentContextUsageSectionInfo[];
  warnings: string[];
}

export interface AgentContextBreakdownInfo {
  systemPromptTokens?: number;
  toolsTokens?: number;
  rulesTokens?: number;
  skillsTokens?: number;
  mcpTokens?: number;
  subagentTokens?: number;
  summaryTokens?: number;
  conversationTokens?: number;
}

export interface AgentTokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextUsage?: AgentContextUsageInfo;
  contextBreakdown?: AgentContextBreakdownInfo;
}

export interface PermissionRequestInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}

export interface QuestionRequestInfo {
  requestId: string;
  sessionId: string;
  questions: unknown[];
  toolCallId?: string;
}

export interface StreamingDeltaInfo {
  isStreaming: boolean;
  isThinking: boolean;
  content: string;
}

// ============================================================================
// Adapter registry
// ============================================================================

/** Map of session category → adapter. Populated at startup via registerAdapter(). */
const adapterRegistry = new Map<string, SessionAdapter>();

/** Register an adapter for a session category. */
export function registerAdapter(adapter: SessionAdapter): void {
  adapterRegistry.set(adapter.category, adapter);
}

/** Get the adapter for a session ID (by detecting category). */
export function getAdapterForSession(
  sessionId: string
): SessionAdapter | undefined {
  if (adapterRegistry.size === 0) {
    log.warn("getAdapterForSession called before adapters were registered");
  }

  if (isAgentSession(sessionId)) {
    return adapterRegistry.get("agent");
  }
  if (isCliSession(sessionId)) {
    return adapterRegistry.get("cli");
  }
  if (isCursorIdeSession(sessionId)) {
    return adapterRegistry.get("cursor_ide");
  }
  if (isExternalHistorySession(sessionId)) {
    return adapterRegistry.get("external_history");
  }
  return undefined;
}

/** Get an adapter by category name. */
export function getAdapter(category: string): SessionAdapter | undefined {
  return adapterRegistry.get(category);
}
