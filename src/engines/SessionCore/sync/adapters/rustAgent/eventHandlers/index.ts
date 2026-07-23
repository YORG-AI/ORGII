/**
 * Unified Rust Agent Event Handlers
 *
 * Dispatches real-time agent WebSocket events into the EventStore.
 * Handles message streaming, tool calls, exec output, subagent tracking,
 * permission/question requests, file changes, and coding session bridging.
 *
 * All events use a single `agent:*` namespace. Feature flags control
 * which capabilities are active per session (not per variant).
 */
import { confirmTurnRunning } from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";

import {
  SPAWNED_SESSION_RE,
  findActiveSubagentCallIndex,
} from "../../shared/subagentTracking";
import type { AgentWSEvent } from "../../shared/types";
import {
  handleAdeAction,
  handleExitPlanMode,
  handlePermissionRequest,
  handlePlanApprovalArchived,
  handlePlanReadyForApproval,
  handleQuestionRequest,
  handleTodosUpdated,
} from "./agentSpecific";
import {
  handleFileChange,
  handleHeartbeat,
  handleSecretRequest,
  handleSetupRepoUpdate,
} from "./fileChangeHandlers";
import { handleMcpProgress } from "./mcpHandlers";
import {
  clearStreamRetryStatus,
  handleComplete,
  handleContextUsage,
  handleError,
  handleGoalLoop,
  handleSessionEvicted,
  handleStreamErrorExhausted,
  handleStreamRetry,
  handleTurnCompleted,
  handleTurnSummary,
  handleWarning,
} from "./sessionHandlers";
import {
  handleMessageDelta,
  handleStreamingComplete,
  handleThinkingDelta,
  handleToolCallDelta,
} from "./streamHandlers";
import {
  getEventSessionId,
  isSessionStreamingStopped,
  noteSessionStreamingTurn,
} from "./streamHelpers";
import { handleCodingSessionEvent } from "./subagentHandlers";
import {
  handleExecOutput,
  handleInteractionFinalized,
  handleShellProcessBackgrounded,
  handleShellProcessExited,
  handleShellProcessStarted,
  handleSubagentJobChanged,
  handleToolCall,
  handleToolResult,
} from "./toolHandlers";
import type { EventHandlerContext } from "./types";

const unknownEventLogger = createLogger("AgentEventDispatch");

// Re-export types and context factory
export type {
  EventHandlerCallbacksInternal,
  EventHandlerContext,
  RustAgentFeatures,
} from "./types";
export { createEventHandlerContext } from "./context";

// ============================================================================
// Main dispatcher
// ============================================================================

const STREAM_RETRY_RECOVERY_EVENTS = new Set<string>([
  "agent:message_delta",
  "agent:thinking_delta",
  "agent:tool_call_delta",
  "agent:tool_call",
  "agent:streaming_complete",
  "agent:tool_result",
  "agent:interaction_finalized",
  "agent:context_usage",
  "agent:complete",
  "agent:plan_ready_for_approval",
  "agent:plan_approval_archived",
  "agent:exit_plan_mode",
  "agent:question_request",
  "permission:request",
  "agent:shell_process_started",
  "agent:shell_process_backgrounded",
  "agent:shell_process_exited",
  "agent:mcp_progress",
]);

const LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP = new Set<string>([
  "agent:message_delta",
  "agent:thinking_delta",
  "agent:tool_call_delta",
  "agent:streaming_complete",
]);

const QUEUE_TURN_ACTIVITY_EVENTS = new Set<string>([
  "agent:message_delta",
  "agent:thinking_delta",
  "agent:tool_call_delta",
  "agent:streaming_complete",
  "agent:tool_call",
  "agent:tool_result",
  "agent:interaction_finalized",
  "agent:shell_process_started",
  "agent:shell_process_backgrounded",
  "agent:shell_process_exited",
  "agent:mcp_progress",
  "agent:context_usage",
  "agent:plan_ready_for_approval",
  "agent:question_request",
  "permission:request",
]);

export async function dispatchAgentEvent(
  event: AgentWSEvent,
  ctx: EventHandlerContext
): Promise<void> {
  const eventSessionId = getEventSessionId(event);
  const sessionId = ctx.filterSessionIdRef.current || "";

  // Coding session bridge (enabled via hasCodingSessionBridge feature flag)
  if (
    ctx.features.hasCodingSessionBridge &&
    eventSessionId &&
    ctx.trackedCodingSessionsRef
  ) {
    const parentEventId =
      ctx.trackedCodingSessionsRef.current.get(eventSessionId);
    if (parentEventId) {
      handleCodingSessionEvent(event, parentEventId, ctx);
      return;
    }

    // Auto-track new spawned coding sessions
    if (
      SPAWNED_SESSION_RE.test(eventSessionId) &&
      !ctx.trackedCodingSessionsRef.current.has(eventSessionId)
    ) {
      const currentEvents = await eventStoreProxy.getEvents();
      const activeIdx = findActiveSubagentCallIndex(currentEvents);
      if (activeIdx >= 0) {
        const parentId = currentEvents[activeIdx].id;
        ctx.trackedCodingSessionsRef.current.set(eventSessionId, parentId);
        handleCodingSessionEvent(event, parentId, ctx);
      }
      return;
    }
  }

  // Filter by session ID
  if (
    ctx.filterSessionIdRef.current &&
    eventSessionId &&
    eventSessionId !== ctx.filterSessionIdRef.current
  ) {
    return;
  }

  if (sessionId && LIVE_STREAM_EVENTS_IGNORED_AFTER_STOP.has(event.type)) {
    noteSessionStreamingTurn(sessionId, event.turnId);
    if (isSessionStreamingStopped(sessionId, event.turnId)) {
      return;
    }
  }

  // Any subsequent successful activity from the same session means the retry
  // episode recovered. Clear the footer pill before dispatching the real event
  // so plan/tool/question surfaces do not leave a ghost "Reconnecting" state.
  if (STREAM_RETRY_RECOVERY_EVENTS.has(event.type)) {
    clearStreamRetryStatus(ctx, sessionId);
  }

  // Raw event traffic is a low-trust signal: it may trail a terminal, so it
  // only confirms a pending dispatch — it never opens a turn from idle.
  if (sessionId && QUEUE_TURN_ACTIVITY_EVENTS.has(event.type)) {
    confirmTurnRunning(sessionId);
  }

  switch (event.type) {
    case "agent:message_delta":
      handleMessageDelta(event, sessionId, ctx);
      break;
    case "agent:thinking_delta":
      handleThinkingDelta(event, sessionId, ctx);
      break;
    case "agent:streaming_complete":
      await handleStreamingComplete(event, sessionId, ctx);
      break;
    case "agent:tool_call_delta":
      handleToolCallDelta(event, sessionId, ctx);
      break;
    case "agent:tool_call":
      handleToolCall(event, sessionId, eventSessionId, ctx);
      break;
    case "agent:stream_retry":
      handleStreamRetry(event, ctx);
      break;
    case "agent:stream_error_exhausted":
      handleStreamErrorExhausted(event, sessionId, ctx);
      break;
    case "agent:exec_output":
      handleExecOutput(event, ctx);
      break;
    case "agent:tool_result":
      await handleToolResult(event, sessionId, ctx);
      break;
    case "agent:interaction_finalized":
      await handleInteractionFinalized(event, sessionId);
      break;
    case "agent:context_usage":
      handleContextUsage(event, ctx);
      break;
    case "agent:complete":
      handleComplete(event, sessionId, ctx);
      break;
    case "agent:turn_completed":
      handleTurnCompleted(event, sessionId, ctx);
      break;
    case "agent:error":
      handleError(event, sessionId, ctx);
      break;
    case "agent:warning":
      handleWarning(event);
      break;
    case "agent:goal_loop":
      handleGoalLoop(event);
      break;
    case "agent:turn_summary":
      handleTurnSummary(event, sessionId);
      break;
    case "agent:ade_action":
      handleAdeAction(event);
      break;
    case "agent:todos_updated":
      handleTodosUpdated(event, eventSessionId, ctx);
      break;
    case "permission:request":
      if (ctx.features.hasPermissionRequest)
        handlePermissionRequest(event, eventSessionId, ctx);
      break;
    case "agent:plan_ready_for_approval":
      handlePlanReadyForApproval(event, eventSessionId, ctx);
      break;
    case "agent:plan_approval_archived":
      handlePlanApprovalArchived(event, eventSessionId, ctx);
      break;
    case "agent:exit_plan_mode":
      handleExitPlanMode(event, eventSessionId, ctx);
      break;
    case "agent:question_request":
      handleQuestionRequest(event, eventSessionId, ctx);
      break;
    case "agent:shell_process_started":
      handleShellProcessStarted(event, eventSessionId, ctx);
      break;
    case "agent:shell_process_backgrounded":
      handleShellProcessBackgrounded(event, eventSessionId, ctx);
      break;
    case "agent:shell_process_exited":
      handleShellProcessExited(event, eventSessionId, ctx);
      break;
    case "agent:subagent_job_changed":
      handleSubagentJobChanged(event, eventSessionId, ctx);
      break;
    case "agent:mcp_progress":
      handleMcpProgress(event, eventSessionId, ctx);
      break;
    case "agent:session_evicted":
      handleSessionEvicted(ctx, sessionId);
      break;
    case "agent:file_change":
      // Side-channel: the agent wrote files. Forwarded as a window event
      // so the file tree / git status / open editors can refresh.
      handleFileChange(event, eventSessionId);
      break;
    case "agent:setup_repo_update":
      // Side-channel: setup_repo clone/checkout/install progress. The Rust
      // payload omits `sessionId`, so fall back to the channel's session.
      handleSetupRepoUpdate(event, eventSessionId || sessionId);
      break;
    case "agent:secret_request":
      // Side-channel: `manage_secrets` wants the user to paste a sensitive
      // value via the secure modal. The plaintext does not flow through
      // this event — only the request metadata.
      handleSecretRequest(event, eventSessionId || sessionId);
      break;
    case "agent:heartbeat":
      // Side-channel: long-running automation liveness ping. The Rust
      // payload carries no `sessionId`, so fall back to the channel's
      // session — the heartbeat is per-session by routing.
      handleHeartbeat(event, eventSessionId || sessionId);
      break;
    // `agent:queue_status` is consumed by the adapter's status state machine
    // (createRustAgentAdapter), not here — it carries no transcript content.
    // `agent:computer_use_entered/exited/aborted` are CU-lock lifecycle
    // signals also tracked by the adapter as turn-neutral events; they
    // intentionally produce no EventStore row.
    // `agent:snapshot_created` only invalidates snapshot consumers through
    // its dedicated bus listener. It is not transcript content and must not
    // resurrect a completed turn as running.
    case "agent:queue_status":
    case "agent:snapshot_created":
    case "agent:computer_use_entered":
    case "agent:computer_use_exited":
    case "agent:computer_use_aborted":
      break;
    default:
      // Unknown event type. Logged once so a new Rust wire event that the
      // frontend has not been taught to handle is visible instead of
      // silently vanishing into the default branch.
      logUnknownAgentEvent(event.type);
      break;
  }
}

/**
 * Track event types we have already warned about so a high-frequency
 * unknown event does not flood the log. Bounded to avoid unbounded growth.
 */
const _warnedUnknownEventTypes = new Set<string>();
const MAX_WARNED_EVENT_TYPES = 100;

function logUnknownAgentEvent(eventType: string): void {
  if (_warnedUnknownEventTypes.has(eventType)) return;
  if (_warnedUnknownEventTypes.size >= MAX_WARNED_EVENT_TYPES) {
    _warnedUnknownEventTypes.clear();
  }
  _warnedUnknownEventTypes.add(eventType);
  unknownEventLogger.warn(
    `unhandled agent wire event "${eventType}" — no dispatcher case. ` +
      `Add a handler or an explicit no-op case.`
  );
}
