/**
 * Rust Agent Adapter Factory
 *
 * Creates a SessionAdapter for Rust-based agents (OS Agent, SDE Agent, Wingman Agent etc).
 * Both agents share the same core architecture:
 * - Load history via Tauri command
 * - Handle real-time events via dispatchAgentEvent
 * - Stop via cancel command
 *
 * Differences are parameterized via config:
 * - Tauri command names
 * - Event handler feature flags
 * - Text transforms
 */
import {
  cancelSession,
  enterAgentOrgSessionIntervention,
  getSession,
  getSessionInfo,
  loadMessages,
} from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  mergeToolResults,
  persistedMessageToSessionEvent,
} from "@src/engines/SessionCore/ingestion/agentMessageAdapters";
import type { PersistedMessage } from "@src/engines/SessionCore/ingestion/agentMessageAdapters";
import { createLogger } from "@src/hooks/logger";
import type { ContextUsageSnapshot } from "@src/store/session/cliSessionStatusAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { retryInvokeTauri } from "@src/util/platform/tauri/retryInvoke";

import type {
  AdapterSendInput,
  AgentTokenUsageInfo,
  EventHandlerCallbacks,
  PostLoadResult,
  RawSessionEvent,
  SessionAdapter,
  SessionEventHandler,
} from "../types";
import type { RustAgentFeatures } from "./rustAgent/eventHandlers";
import {
  createEventHandlerContext,
  dispatchAgentEvent,
} from "./rustAgent/eventHandlers";
import {
  clearSessionStreamingStopped,
  isSessionStreamingStopped,
  markSessionStreamingStopped,
  noteSessionStreamingTurn,
  resetAllStreamingState,
} from "./rustAgent/eventHandlers/streamHelpers";
import type {
  AgentTokenUsage,
  AgentWSEvent,
  PermissionRequestEvent,
  QuestionRequestEvent,
  StreamingInfo,
} from "./shared/types";

// ============================================================================
// Configuration
// ============================================================================

export interface RustAgentConfig {
  /** Session category identifier (e.g., "os", "agent") */
  category: string;

  /** Async function to load persisted messages */
  loadMessages: (sessionId: string) => Promise<PersistedMessage[]>;

  /** Async function to cancel/stop the session */
  cancel: (sessionId: string, reason: CancelReason) => Promise<void>;

  /** Tauri command to fetch token usage (optional, SDE only) */
  tokenUsageCommand?: string;

  /** Transform user message display text (OS strips terminal blocks) */
  transformUserText?: (content: string) => string;

  /** Event handler feature flags */
  features: RustAgentFeatures;
}

const logger = createLogger("RustAgentAdapter");

interface TokenUsageRecord {
  inputTokens: number;
  contextTokens: number;
  contextUsageJson?: string | null;
}

function parseContextUsageSnapshot(
  raw: string | null | undefined
): ContextUsageSnapshot | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ContextUsageSnapshot;
  } catch {
    return undefined;
  }
}

export function getLatestContextUsageSnapshot(
  records: readonly { contextUsageJson?: string | null }[]
): ContextUsageSnapshot | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const contextUsage = parseContextUsageSnapshot(
      records[index]?.contextUsageJson
    );
    if (contextUsage) return contextUsage;
  }
  return undefined;
}

function toTokenUsageInfo(usage: AgentTokenUsage): AgentTokenUsageInfo {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    contextTokens: usage.contextTokens,
    ...(usage.contextUsage ? { contextUsage: usage.contextUsage } : {}),
    ...(usage.contextBreakdown
      ? { contextBreakdown: usage.contextBreakdown }
      : {}),
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a SessionAdapter for a Rust-based agent.
 */
export function createRustAgentAdapter(
  config: RustAgentConfig
): SessionAdapter {
  const {
    category,
    loadMessages,
    cancel,
    tokenUsageCommand,
    transformUserText,
    features,
  } = config;

  return {
    category,

    async loadHistory(
      sessionId: string,
      signal: AbortSignal
    ): Promise<SessionEvent[]> {
      const persistedMessages = await loadMessages(sessionId);
      if (signal.aborted || !persistedMessages?.length) return [];

      const events = persistedMessages.map((msg) =>
        persistedMessageToSessionEvent(msg, sessionId, {
          transformDisplayText: transformUserText
            ? (content, source) =>
                source === "user" ? transformUserText(content) : content
            : undefined,
        })
      );

      const merged = await mergeToolResults(events);
      if (signal.aborted) return merged;

      await backfillSubagentLinks(sessionId, merged);
      return merged;
    },

    async postLoad(
      sessionId: string,
      signal: AbortSignal
    ): Promise<PostLoadResult> {
      const result: PostLoadResult = {};

      // Restore session status from DB so the UI reflects the correct
      // terminal state when switching to a completed/failed session.
      try {
        const record = await getSession(sessionId);
        if (signal.aborted) return result;
        if (record?.status && record.status !== "idle") {
          const isInFlight =
            record.status === "running" ||
            record.status === "waiting_for_user" ||
            record.status === "waiting_for_funds";

          if (isInFlight) {
            // DB says in-flight — verify against the Rust runtime HashMap.
            // If the session is not alive (crash recovery, idle eviction,
            // IPC channel drop that lost agent:complete), override to idle
            // so the frontend doesn't show a phantom active session.
            const info = await getSessionInfo(sessionId);
            if (signal.aborted) return result;
            if (!info) {
              logger.warn(
                `[${category}] postLoad: DB says "${record.status}" but session not in Rust runtime — treating as idle`
              );
              result.runStatus = "idle";
            } else {
              result.runStatus = record.status;
            }
          } else {
            result.runStatus = record.status;
            if (
              (record.status === "failed" || record.status === "error") &&
              record.errorMessage
            ) {
              result.runError = record.errorMessage;
            }
          }
        }
      } catch (err) {
        logger.warn(`[${category}] postLoad session fetch failed:`, err);
      }

      if (signal.aborted) return result;

      // Token usage — SDE agent only
      if (!tokenUsageCommand) return result;

      try {
        const records = await invokeTauri<TokenUsageRecord[]>(
          tokenUsageCommand,
          { sessionId }
        );
        if (signal.aborted) return result;
        if (records?.length) {
          const last = records[records.length - 1];
          const fill =
            last.contextTokens > 0 ? last.contextTokens : last.inputTokens;
          if (fill > 0) result.contextTokens = fill;
          const contextUsage = getLatestContextUsageSnapshot(records);
          if (contextUsage) result.contextUsage = contextUsage;
        }
      } catch (err) {
        logger.warn(`[${category}] postLoad token fetch failed:`, err);
      }

      return result;
    },

    createEventHandler(
      sessionId: string,
      callbacks: EventHandlerCallbacks
    ): SessionEventHandler {
      let _streaming = false;

      // Two-flag system for status signaling:
      //
      // _runningSignaled: true while the current turn is in-flight (between first
      //   non-terminal event and terminal event processing). Prevents duplicate
      //   "running" signals within the same turn.
      //
      // _turnCompleted: true after a terminal event (agent:complete / agent:error)
      //   has been processed. Once set, no further event can re-trigger "running"
      //   until reset() is called (session switch). This blocks all trailing events
      //   Legacy trailing events are blocked here so old persisted/replayed
      //   summaries cannot re-trigger "running" after completion.
      let _runningSignaled = false;
      let _turnCompleted = false;
      // Disposal guard: set to true when dispose() is called so that any
      // in-flight promise chain steps are no-ops. Without this, a slow
      // promise chain could write events from the old session into the
      // new session's Rust EventStore after a session switch.
      let _disposed = false;

      // Event queue to ensure sequential processing (prevents race conditions)
      let eventQueuePromise = Promise.resolve();

      // Consecutive dispatch failures within a single turn. A handler that
      // throws leaves the EventStore potentially inconsistent (a tool_call
      // row written but its result never paired, a delta lost). One isolated
      // failure is tolerable, but a run of them means the turn is silently
      // diverging from the Rust truth — at DISPATCH_FAILURE_THRESHOLD we
      // surface a "failed" status so the user sees the desync instead of a
      // session that hangs in "running" forever.
      let _consecutiveDispatchFailures = 0;
      const DISPATCH_FAILURE_THRESHOLD = 3;

      const ctx = createEventHandlerContext(sessionId, features, {
        onAgentComplete: (tokenUsage?: AgentTokenUsage) => {
          callbacks.onAgentComplete?.(
            tokenUsage ? toTokenUsageInfo(tokenUsage) : undefined
          );
        },
        onContextUsage: (contextUsage) => {
          callbacks.onContextUsage?.(contextUsage);
        },
        onTokenUpdate: (tokens) => {
          callbacks.onTokenUpdate?.(tokens);
        },
        onStatusChange: (
          status: string,
          errorMessage?: string,
          meta?: {
            turnId?: string;
            turnStatus?: string;
            intermediate?: boolean;
          }
        ) => {
          callbacks.onStatusChange?.(status, errorMessage, meta);
        },
        onPermissionRequest: features.hasPermissionRequest
          ? (event: PermissionRequestEvent) => {
              callbacks.onPermissionRequest?.({
                requestId: event.requestId,
                sessionId: event.sessionId,
                tool: event.tool,
                toolCallId: event.toolCallId,
                args: event.args,
              });
            }
          : undefined,
        onQuestionRequest: (event: QuestionRequestEvent) => {
          callbacks.onQuestionRequest?.({
            requestId: event.requestId,
            sessionId: event.sessionId,
            questions: event.questions,
            toolCallId: event.toolCallId,
          });
        },
        onStreamingDelta: features.hasStreamingDelta
          ? (info: StreamingInfo) => {
              callbacks.onStreamingDelta?.({
                isStreaming: info.isStreaming,
                isThinking: info.isThinking,
                content: info.content,
              });
            }
          : undefined,
        setStreaming: (value: boolean) => {
          _streaming = value;
          eventStoreProxy.setStreaming(value, sessionId);
        },
      });

      // Terminal event types — signal turn completion and lock out further "running" signals.
      // `agent:turn_completed` is a lifecycle terminal marker, not transcript content.
      const TERMINAL_EVENTS = new Set([
        "agent:complete",
        "agent:turn_completed",
        "agent:error",
        "agent:stream_error_exhausted",
        "agent:session_evicted",
      ]);

      // Pure post-complete trailing events: these ONLY appear after agent:complete and
      // are never part of an active turn. Safe to ignore for "running" signaling
      // regardless of _turnCompleted state.
      //
      // - agent:turn_summary — legacy summary events from older sessions
      // - agent:warning — from async background task failures (memory extraction, etc.)
      // - agent:queue_status — scheduler idle broadcasts; active queue status is
      //   handled separately as a real running-state signal
      // - agent:shell_process_started/backgrounded/exited — background process
      //   lifecycle from subprocess monitor task; they update EventStore args
      //   but never represent a new LLM turn. They can arrive during or after a
      //   turn (backgrounded/exited especially can fire long after agent:complete).
      // - agent:exec_output — streaming output from background processes; can arrive
      //   after agent:complete when a backgrounded command is still running.
      // - agent:computer_use_entered / agent:computer_use_exited — desktop/Wingman
      //   CU-lock lifecycle. `exited` is broadcast by the processor immediately
      //   after `agent:complete` (see processor.rs §9a½), so if it were treated
      //   as a "new turn" event the adapter would flip the input bar back to
      //   "running" and the Stop button would get stuck. These events carry no
      //   turn semantics — they only signal process-wide lock state.
      //
      // NOTE: agent:subagent_* were retired — Rust owns that path now.
      const ALWAYS_TRAILING_EVENTS = new Set([
        "agent:turn_summary",
        "agent:warning",
        "agent:goal_loop",
        "agent:ade_action",
        "agent:shell_process_started",
        "agent:shell_process_backgrounded",
        "agent:shell_process_exited",
        "agent:exec_output",
        "agent:computer_use_entered",
        "agent:computer_use_exited",
      ]);

      const PLAN_SUBMITTED_END_TURN_PREFIX = "PLAN_SUBMITTED_END_TURN:";
      const LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP = new Set([
        "agent:message_delta",
        "agent:thinking_delta",
        "agent:tool_call_delta",
        "agent:streaming_complete",
      ]);

      return {
        handleEvent(raw: RawSessionEvent): void {
          if (_disposed) return;

          const payload =
            raw.payload && typeof raw.payload === "object" ? raw.payload : {};
          const event = {
            ...raw,
            ...payload,
            type: raw.type,
          } as unknown as AgentWSEvent;

          if (LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP.has(event.type)) {
            noteSessionStreamingTurn(sessionId, event.turnId);
          }

          const shouldIgnoreAfterStop =
            isSessionStreamingStopped(sessionId, event.turnId) &&
            LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP.has(event.type);
          if (shouldIgnoreAfterStop) return;

          const isPlanReadyTerminal =
            event.type === "agent:plan_ready_for_approval" &&
            event.planEventSource === "create_plan";
          const isPlanSubmittedToolResult =
            event.type === "agent:tool_result" &&
            (event.tool === "create_plan" ||
              event.toolName === "create_plan") &&
            typeof event.result === "string" &&
            event.result.startsWith(PLAN_SUBMITTED_END_TURN_PREFIX);
          const isTerminal =
            TERMINAL_EVENTS.has(event.type) || isPlanReadyTerminal;
          const isQueueStatus = event.type === "agent:queue_status";
          const queueIsProcessing = event.isProcessing === true;
          const isActiveQueueStatus = isQueueStatus && queueIsProcessing;
          const isTrailing =
            ALWAYS_TRAILING_EVENTS.has(event.type) ||
            isPlanSubmittedToolResult ||
            (isQueueStatus && !isActiveQueueStatus);

          if (isQueueStatus) {
            if (isActiveQueueStatus && !_runningSignaled) {
              _runningSignaled = true;
              callbacks.onStatusChange?.("running");
            }
          }

          // New turn detection: if _turnCompleted is true (previous turn ended) and
          // a genuine new-turn event (non-trailing, non-terminal) arrives, reset gate.
          if (_turnCompleted && !isTrailing && !isTerminal) {
            _turnCompleted = false;
            _runningSignaled = false;
          }

          // Signal "running" on the first substantive event of each turn.
          // Skip: terminal events (carry their own onStatusChange transition),
          //        trailing events (post-complete cleanup, must not flip status back).
          if (
            !_turnCompleted &&
            !_runningSignaled &&
            !isTerminal &&
            !isTrailing
          ) {
            _runningSignaled = true;
            callbacks.onStatusChange?.("running");
          }

          // Queue events for sequential processing.
          // Set _turnCompleted INSIDE the promise chain so it fires only after
          // the terminal handler's onStatusChange("completed"/"failed") has run.
          // Each step checks _disposed so that a session switch (dispose) stops
          // the chain from writing stale events into the new session's store.
          eventQueuePromise = eventQueuePromise
            .then(() => {
              if (_disposed) return;
              if (
                LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP.has(event.type) &&
                isSessionStreamingStopped(sessionId, event.turnId)
              ) {
                return;
              }
              return dispatchAgentEvent(event, ctx);
            })
            .then(() => {
              if (_disposed) return;
              // A clean dispatch resets the desync counter.
              _consecutiveDispatchFailures = 0;
              if (isTerminal) {
                _runningSignaled = false;
                _turnCompleted = true;
              }
            })
            .catch((err) => {
              logger.error(
                `[${category}] event dispatch failed for "${event.type}" on ${sessionId}:`,
                err
              );
              if (_disposed) return;

              if (isTerminal) {
                // The terminal event itself failed to apply. Still mark the
                // turn completed so the input bar unlocks, but the counter
                // below will have already surfaced any prior desync.
                _runningSignaled = false;
                _turnCompleted = true;
                _consecutiveDispatchFailures = 0;
                return;
              }

              // Non-terminal failure mid-turn: the EventStore is now a step
              // out of sync with the Rust runtime. Count it; if the turn
              // keeps failing to apply events, break the silent divergence
              // by forcing a visible failed status.
              _consecutiveDispatchFailures += 1;
              if (
                _consecutiveDispatchFailures >= DISPATCH_FAILURE_THRESHOLD &&
                !_turnCompleted
              ) {
                logger.error(
                  `[${category}] ${_consecutiveDispatchFailures} consecutive dispatch failures on ${sessionId} — surfacing failed status to break silent desync`
                );
                _runningSignaled = false;
                _turnCompleted = true;
                _consecutiveDispatchFailures = 0;
                callbacks.onStatusChange?.(
                  "failed",
                  "Event stream desynchronized — some agent output may be missing. Reload the session to recover."
                );
              }
            });
        },

        reset(): void {
          resetAllStreamingState(ctx);

          ctx.trackedCodingSessionsRef?.current.clear();

          _streaming = false;
          _runningSignaled = false;
          _turnCompleted = false;
          _consecutiveDispatchFailures = 0;
          eventStoreProxy.setStreaming(false, sessionId);
        },

        get isStreaming(): boolean {
          return _streaming;
        },

        dispose(): void {
          _disposed = true;
          this.reset();
        },
      };
    },

    async sendMessage(input: AdapterSendInput): Promise<void> {
      const {
        sessionId,
        content,
        displayText,
        model,
        accountId,
        mode,
        adeContext,
        imageDataUrls,
        isResume,
        clientMessageId,
        turnIntentId,
        sessionRepoPath,
      } = input;
      // The session row's persisted repo is the source of truth for
      // workspace_root. Using the global repo selection atom would collide
      // when two sessions on different repos are open simultaneously.
      const activePath = sessionRepoPath ?? undefined;
      clearSessionStreamingStopped(sessionId);
      if (!isResume && content.trim()) {
        await enterAgentOrgSessionIntervention(sessionId);
      }
      await retryInvokeTauri(
        "agent_send_message",
        {
          sessionId,
          content,
          ...(displayText && displayText !== content ? { displayText } : {}),
          ...(model ? { model } : {}),
          ...(accountId ? { accountId } : {}),
          ...(mode ? { mode } : {}),
          ...(activePath ? { workspacePath: activePath } : {}),
          ...(imageDataUrls && imageDataUrls.length > 0
            ? { images: imageDataUrls }
            : {}),
          ...(adeContext ? { ideContext: adeContext } : {}),
          ...(isResume ? { isResume: true } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(turnIntentId ? { turnIntentId } : {}),
        },
        sessionId
      );
    },

    async stopSession(sessionId: string, reason: CancelReason): Promise<void> {
      markSessionStreamingStopped(sessionId);
      void eventStoreProxy.setStreaming(false, sessionId);
      await cancel(sessionId, reason);
    },
  };
}

// ============================================================================
// Preset Configuration
// ============================================================================

/** Unified agent configuration — handles all Rust-native agents (OS, SDE, custom). */
export const AGENT_CONFIG: RustAgentConfig = {
  category: "agent",
  loadMessages: (sessionId) =>
    loadMessages(sessionId) as Promise<unknown> as Promise<PersistedMessage[]>,
  cancel: (sessionId, reason) =>
    cancelSession(sessionId, reason) as unknown as Promise<void>,
  tokenUsageCommand: "get_session_token_usage_records",
  features: {
    hasCodingSessionBridge: true,
    hasToolCallDelta: true,
    hasPermissionRequest: true,
    hasFileChangeEvents: true,
    hasStreamingDelta: true,
  },
};

// ============================================================================
// Subagent Link Backfill
// ============================================================================

interface ChildSessionRecord {
  sessionId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId: string | null;
  parentEventId: string | null;
}

/**
 * Retroactively stamp `subagentSessionId` on parent `agent` tool_call events
 * that are missing the link. Older sessions were persisted before Rust began
 * stamping `subagentSessionId` into tool_call args, so the message-layer
 * `loadHistory` path never sees it. This queries `agent_sessions` for child
 * rows and matches them to unlinked parent events.
 *
 * Mutates `events` in-place for zero-copy efficiency.
 */
async function backfillSubagentLinks(
  parentSessionId: string,
  events: SessionEvent[]
): Promise<void> {
  const hasSubagentId = (ev: SessionEvent): boolean => {
    const argsObj = ev.args as Record<string, unknown> | undefined;
    return Boolean(argsObj?.subagentSessionId);
  };
  const agentCalls = events.filter(
    (ev) =>
      ev.actionType === "tool_call" &&
      ev.functionName === "agent" &&
      !hasSubagentId(ev)
  );
  if (agentCalls.length === 0) return;

  let children: ChildSessionRecord[];
  try {
    children = await invokeTauri<ChildSessionRecord[]>(
      "es_get_child_sessions",
      { parentSessionId }
    );
  } catch {
    return;
  }
  if (children.length === 0) return;

  const byEventId = new Map<string, ChildSessionRecord>();
  const unmatched: ChildSessionRecord[] = [];
  for (const child of children) {
    if (child.parentEventId) {
      byEventId.set(child.parentEventId, child);
    } else {
      unmatched.push(child);
    }
  }

  const remainingCalls: SessionEvent[] = [];
  for (const ev of agentCalls) {
    const child = byEventId.get(ev.id);
    if (child) {
      stampSubagentArgs(ev, child.sessionId);
    } else {
      remainingCalls.push(ev);
    }
  }

  if (remainingCalls.length > 0 && unmatched.length > 0) {
    unmatched.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const limit = Math.min(remainingCalls.length, unmatched.length);
    for (let idx = 0; idx < limit; idx++) {
      stampSubagentArgs(remainingCalls[idx], unmatched[idx].sessionId);
    }
  }
}

function stampSubagentArgs(event: SessionEvent, childSessionId: string): void {
  const args = (event.args ?? {}) as Record<string, unknown>;
  args.subagentSessionId = childSessionId;
  args.action = args.action ?? "delegate";
  event.args = args as SessionEvent["args"];
}
