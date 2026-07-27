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
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";
import type { ContextUsageSnapshot } from "@src/store/session/cliSessionStatusAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { retryInvokeTauri } from "@src/util/platform/tauri/retryInvoke";
import { isSessionEngineActiveStatus } from "@src/util/session/sessionRuntimeExecuting";

import { noteSessionChannelActivity } from "../sessionChannelActivity";
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
import {
  applyLlmUsageToEvents,
  applyToolUsageToEvents,
  loadUsageTelemetry,
} from "./rustAgent/toolUsageCache";
import { buildRustAgentSendMessageArgs } from "./rustAgentSendPayload";
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

export interface StreamingEdgeController {
  readonly value: boolean;
  set(value: boolean): void;
}

export function createStreamingEdgeController(
  write: (value: boolean) => void
): StreamingEdgeController {
  let lastValue: boolean | undefined;
  return {
    get value(): boolean {
      return lastValue ?? false;
    },
    set(value: boolean): void {
      if (lastValue === value) return;
      lastValue = value;
      write(value);
    },
  };
}

// Terminal event types — signal turn completion and lock out further
// "running" signals. Module-scoped because every open Rust session shares
// the same wire contract; rebuilding these sets per handler retains needless
// allocations across repeated session switches.
const TERMINAL_EVENTS = new Set([
  "agent:complete",
  "agent:turn_completed",
  "agent:error",
  "agent:stream_error_exhausted",
  "agent:session_evicted",
]);

// Events that may arrive while a turn is running or after it has completed,
// but never start a new LLM turn by themselves. In particular,
// `agent:snapshot_created` is emitted asynchronously after snapshot
// persistence. Treating it as a new-turn signal resurrected a completed
// session as `running`, leaving a permanent green sidebar indicator even
// though the composer had already returned to Send.
const TURN_NEUTRAL_EVENTS = new Set([
  "agent:turn_summary",
  "agent:warning",
  "agent:goal_loop",
  "agent:ade_action",
  "agent:shell_process_started",
  "agent:shell_process_backgrounded",
  "agent:shell_process_exited",
  "agent:exec_output",
  "agent:context_usage",
  "agent:file_change",
  "agent:setup_repo_update",
  "agent:heartbeat",
  "agent:snapshot_created",
  "agent:computer_use_entered",
  "agent:computer_use_exited",
  "agent:computer_use_aborted",
]);

export function isRustAgentTurnNeutralEvent(eventType: string): boolean {
  return TURN_NEUTRAL_EVENTS.has(eventType);
}

const PLAN_SUBMITTED_END_TURN_PREFIX = "PLAN_SUBMITTED_END_TURN:";
const LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP = new Set([
  "agent:message_delta",
  "agent:thinking_delta",
  "agent:tool_call_delta",
  "agent:streaming_complete",
]);

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

async function refreshUsageForLatestEvents(sessionId: string): Promise<void> {
  const { toolUsageByCallId, llmUsageByTurnId } =
    await loadUsageTelemetry(sessionId);
  if (toolUsageByCallId.size === 0 && llmUsageByTurnId.size === 0) return;

  const snapshot = eventStoreProxy.getLatestSessionSnapshot(sessionId);
  const events = snapshot?.chatEvents ?? [];
  const hydratedEvents = applyLlmUsageToEvents(
    applyToolUsageToEvents(events, toolUsageByCallId),
    llmUsageByTurnId
  );
  const updates = hydratedEvents.flatMap((event, index) => {
    if (event.args === events[index]?.args) return [];
    return [
      eventStoreProxy.updateById(event.id, { args: event.args }, sessionId),
    ];
  });
  await Promise.all(updates);
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
  const streamingControllers = new Map<string, StreamingEdgeController>();

  const getStreamingController = (sessionId: string) => {
    const existing = streamingControllers.get(sessionId);
    if (existing) return existing;
    const created = createStreamingEdgeController((value) => {
      void eventStoreProxy.setStreaming(value, sessionId);
    });
    streamingControllers.set(sessionId, created);
    return created;
  };

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

      const { toolUsageByCallId, llmUsageByTurnId } =
        await loadUsageTelemetry(sessionId);
      if (signal.aborted) return merged;
      const usageHydrated = applyLlmUsageToEvents(
        applyToolUsageToEvents(merged, toolUsageByCallId),
        llmUsageByTurnId
      );

      await backfillSubagentLinks(sessionId, usageHydrated);
      return usageHydrated;
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
          const isInFlight = isSessionEngineActiveStatus(record.status);

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
      const streamingController = getStreamingController(sessionId);

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

      // One hung dispatch (an IPC invoke that never settles) must not starve
      // every later event — the terminal would never apply and the turn only
      // ends via the 60s planning watchdog. After the deadline the queue
      // moves on; the stalled dispatch's late outcome is logged, not thrown.
      const QUEUE_DISPATCH_DEADLINE_MS = 15_000;
      const withQueueDeadline = (
        dispatch: Promise<void>,
        eventType: string
      ): Promise<void> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            logger.error(
              `[${category}] dispatch of "${eventType}" on ${sessionId} ` +
                `exceeded ${QUEUE_DISPATCH_DEADLINE_MS}ms — releasing the ` +
                `event queue so terminal events cannot starve`
            );
            dispatch.then(
              () =>
                logger.warn(
                  `[${category}] stalled "${eventType}" dispatch on ` +
                    `${sessionId} eventually completed`
                ),
              (err) =>
                logger.warn(
                  `[${category}] stalled "${eventType}" dispatch on ` +
                    `${sessionId} eventually failed:`,
                  err
                )
            );
            resolve();
          }, QUEUE_DISPATCH_DEADLINE_MS);
          dispatch.then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            }
          );
        });

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
          // Token/thinking deltas all assert the same active state. The shared
          // controller coalesces identical edges across handler replacement.
          streamingController.set(value);
        },
      });
      return {
        handleEvent(raw: RawSessionEvent): void {
          if (_disposed) {
            if (TERMINAL_EVENTS.has(raw.type)) {
              logger.warn(
                `[${category}] disposed handler swallowed ${raw.type} for ${sessionId}`
              );
            }
            return;
          }

          // Liveness stamp for EVERY channel event, before any filtering.
          // Ephemeral events (tool_call_delta, stream_retry) never reach the
          // EventStore, so this is the only place their arrival is recorded;
          // the planning watchdog reads it to distinguish "backend still
          // streaming" from "backend went silent".
          noteSessionChannelActivity(sessionId);

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
            isRustAgentTurnNeutralEvent(event.type) ||
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
              return withQueueDeadline(
                dispatchAgentEvent(event, ctx),
                event.type
              );
            })
            .then(() => {
              if (_disposed) return;
              // A clean dispatch resets the desync counter.
              _consecutiveDispatchFailures = 0;
              if (isTerminal) {
                _runningSignaled = false;
                _turnCompleted = true;
                void refreshUsageForLatestEvents(sessionId).catch((err) => {
                  logger.warn(
                    `[${category}] terminal tool usage refresh failed:`,
                    err
                  );
                });
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

          _runningSignaled = false;
          _turnCompleted = false;
          _consecutiveDispatchFailures = 0;
          streamingController.set(false);
        },

        get isStreaming(): boolean {
          return streamingController.value;
        },

        dispose(): void {
          _disposed = true;
          this.reset();
          if (streamingControllers.get(sessionId) === streamingController) {
            streamingControllers.delete(sessionId);
          }
        },
      };
    },

    async sendMessage(input: AdapterSendInput): Promise<void> {
      const { sessionId } = input;
      clearSessionStreamingStopped(sessionId);
      await retryInvokeTauri(
        "agent_send_message",
        buildRustAgentSendMessageArgs(input),
        sessionId
      );
    },

    async stopSession(sessionId: string, reason: CancelReason): Promise<void> {
      markSessionStreamingStopped(sessionId);
      const existingController = streamingControllers.get(sessionId);
      const streamingController =
        existingController ?? getStreamingController(sessionId);
      streamingController.set(false);
      if (!existingController) streamingControllers.delete(sessionId);
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
      normalizeFunctionName(ev.functionName) === "subagent" &&
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
