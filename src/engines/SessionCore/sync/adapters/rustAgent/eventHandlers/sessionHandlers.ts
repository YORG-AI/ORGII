/**
 * Session Handlers
 *
 * Handlers for agent:complete, agent:error, and agent:warning events.
 */
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import { streamRetryStatusAtom } from "@src/store/session/cliSessionStatusAtom";

import {
  makeErrorEvent,
  makeRateLimitHintEvent,
  makeSummaryEvent,
} from "../../shared/eventBuilders";
import type { AgentTokenUsage, AgentWSEvent } from "../../shared/types";
import { resetAllStreamingState } from "./streamHelpers";
import type { EventHandlerContext } from "./types";

const log = createLogger("SessionHandlers");

function settleTerminalRuntime(
  sessionId: string,
  ctx: EventHandlerContext,
  status: "completed" | "failed" | "cancelled" = "completed",
  errorMessage?: string,
  meta?: { turnId?: string; turnStatus?: string }
): void {
  resetAllStreamingState(ctx);
  ctx.setStreaming(false);
  clearStreamRetryStatus(ctx, sessionId);
  ctx.onStatusChangeRef.current?.(status, errorMessage, meta);
}

export function handleContextUsage(
  event: AgentWSEvent,
  ctx: EventHandlerContext
): void {
  if (event.contextUsage) {
    ctx.onContextUsageRef.current?.(event.contextUsage);
  } else if (
    typeof event.contextTokens === "number" &&
    event.contextTokens > 0
  ) {
    ctx.onTokenUpdateRef.current?.(event.contextTokens);
  }
}

export function handleComplete(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  resetAllStreamingState(ctx);
  ctx.setStreaming(false);
  clearStreamRetryStatus(ctx, sessionId);

  if (!event.isStreamError) {
    void eventStoreProxy.saveToCache(sessionId);
  }

  const tokenUsage: AgentTokenUsage | undefined =
    typeof event.totalTokens === "number"
      ? {
          promptTokens: event.promptTokens ?? 0,
          completionTokens: event.completionTokens ?? 0,
          totalTokens: event.totalTokens,
          contextTokens: event.contextTokens ?? event.promptTokens ?? 0,
          ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
          ...(event.contextBreakdown
            ? { contextBreakdown: event.contextBreakdown }
            : {}),
        }
      : undefined;
  ctx.onAgentCompleteRef.current?.(tokenUsage);
  ctx.onStatusChangeRef.current?.("completed");
}

export function handleTurnCompleted(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  const cancelled =
    event.turnStatus === "cancelled" || event.sessionStatus === "cancelled";
  const failed =
    event.turnStatus === "failed" ||
    event.sessionStatus === "failed" ||
    event.sessionStatus === "error";
  const status = cancelled ? "cancelled" : failed ? "failed" : "completed";
  settleTerminalRuntime(sessionId, ctx, status, undefined, {
    turnId: event.turnId,
    turnStatus: event.turnStatus,
  });
}

export function handleTurnSummary(
  event: AgentWSEvent,
  sessionId: string
): void {
  if (!event.summary || !event.turnId || !event.createdAt) return;
  const summaryEvent = makeSummaryEvent(
    sessionId,
    event.summary,
    event.toolCalls,
    event.wallTimeSecs,
    { turnId: event.turnId, createdAt: event.createdAt }
  );
  eventStoreProxy.upsert(summaryEvent, sessionId);
}

export function handleError(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  // Build structured error event from the payload.
  // If a retry series is in progress for this session (stamped by
  // handleStreamRetry), reuse the same block ID so that each per-attempt
  // agent:error overwrites the previous one via upsert instead of stacking
  // N identical "Error / Reconnecting…" cards in the chat history.
  const existingRetryId = _retryBlockId.get(sessionId);
  const errorEvent = makeErrorEvent(
    sessionId,
    {
      error: event.error || "Unknown error",
      errorCode: event.errorCode,
      isRetryable: event.isRetryable,
      details: event.details,
    },
    existingRetryId
  );
  if (existingRetryId) {
    eventStoreProxy.upsert(errorEvent, sessionId);
  } else {
    eventStoreProxy.append([errorEvent], sessionId);
  }

  // The retry episode is now concluded (error is final). Clear the block ID
  // so any future independent error in this session gets a fresh block.
  _retryBlockId.delete(sessionId);

  // Keep the user message visible. The user's prompt stays on screen so
  // they can see what failed and hit
  // "Resume" to retry without re-entering their message.

  // Persist error immediately so it survives session switches
  void eventStoreProxy.saveToCache(sessionId);

  // Reset all streaming state
  resetAllStreamingState(ctx);
  ctx.setStreaming(false);
  clearStreamRetryStatus(ctx, sessionId);
  // Status change fires before onAgentComplete so session activity is already
  // terminal before completion callbacks update derived session state.
  ctx.onStatusChangeRef.current?.("failed", event.error);
  ctx.onAgentCompleteRef.current?.();
}

export function handleWarning(event: AgentWSEvent): void {
  const warning = event.warning || "Unknown warning";
  const source = event.source || "unknown";
  log.warn(`[agent:warning] [${source}] ${warning}`);
  Message.warning(`[${source}] ${warning}`, 5000);
}

/**
 * Goal-loop lifecycle (presence goal mode). Continuation turns are
 * already visible in the transcript as `↻ Continuing toward goal (n/M)`
 * user-side rows; this handler surfaces only the terminal transitions
 * (achieved / paused-on-budget) as toasts so the user notices them even
 * when the session is in the background.
 */
export function handleGoalLoop(event: AgentWSEvent): void {
  const status = event.status as string | undefined;
  const message = (event.message as string | undefined) ?? "";
  if (status === "achieved") {
    Message.success(message || "Goal achieved", 6000);
  } else if (status === "paused") {
    Message.warning(message || "Goal paused — turn budget used", 8000);
  }
  // "continuing" is intentionally silent: the transcript row carries it.
}

/**
 * Module-level tracker for rate-limit hint deduplication.
 * Ensures we only append one hint event per rate-limit "episode"
 * (consecutive retries with kind=rate_limited).  Resets when the
 * retry clears (stream recovered or session changes).
 */
const _rateLimitHintState = { sessionId: "", hintShown: false };

/**
 * Per-session ID of the in-progress retry placeholder block.
 *
 * When Rust fires `agent:stream_retry` before each retry attempt it also
 * sends an `agent:error` for that attempt. Without deduplication each attempt
 * appends a new error block — the user sees N identical "Error / Reconnecting…"
 * cards stacked on top of each other.
 *
 * Fix: `handleStreamRetry` stamps a fixed ID here. `handleError` checks the
 * map: if a retry block already exists for the session it upserts (overwrites)
 * that block instead of appending a new one. `clearStreamRetryStatus` removes
 * the entry so the next independent error gets a fresh block as normal.
 */
const _retryBlockId = new Map<string, string>();

/**
 * `agent:stream_retry` — low-key footer indicator while the Rust turn executor
 * is silently retrying a network-interrupted LLM call. The UI subscribes to
 * `streamRetryStatusAtom` and renders a pill above the input area.
 *
 * Also stamps `_retryBlockId` so that any subsequent `agent:error` events
 * (one per retry attempt) are merged into a single block via upsert instead of
 * being appended as separate cards.
 *
 * When persistent rate limiting is detected (kind=rate_limited, attempt >= 2),
 * a one-time informational event block is appended to the chat to suggest the
 * user switch to another window.
 */
export function handleStreamRetry(
  event: AgentWSEvent,
  ctx: EventHandlerContext
): void {
  const store = ctx.getDefaultStore();
  if (!store) return;
  const sessionId = event.sessionId;
  if (!sessionId) return;
  const kind = event.kind ?? "unknown";
  const attempt = event.attempt ?? 0;
  const maxAttempts = event.maxAttempts ?? 0;
  const backoffMs = event.backoffMs ?? 0;
  store.set(streamRetryStatusAtom, {
    sessionId,
    kind,
    attempt,
    maxAttempts,
    backoffMs,
    startedAt: Date.now(),
  });
  if (sessionId && !_retryBlockId.has(sessionId)) {
    _retryBlockId.set(sessionId, `stream-retry-${sessionId}`);
  }

  if (
    kind === "rate_limited" &&
    attempt >= 2 &&
    sessionId &&
    !(
      _rateLimitHintState.sessionId === sessionId &&
      _rateLimitHintState.hintShown
    )
  ) {
    _rateLimitHintState.sessionId = sessionId;
    _rateLimitHintState.hintShown = true;
    const hintEvent = makeRateLimitHintEvent(sessionId);
    eventStoreProxy.append([hintEvent], sessionId);
  }
}

/**
 * `agent:stream_error_exhausted` — terminal failure after the retry budget
 * was exhausted. Clears the low-key retry status (we're done retrying) and
 * delegates to the regular error rendering path by synthesizing an
 * `agent:error` event. The accompanying assistant chat bubble with the
 * user-visible failure message is already written via `final_content`
 * injected by turn_executor and surfaced through `agent:complete`, so we
 * don't duplicate that here.
 */
export function handleStreamErrorExhausted(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): void {
  clearStreamRetryStatus(ctx, sessionId);
  const message =
    event.message ||
    `Connection to the model provider failed after ${event.attempts ?? "multiple"} retries.`;
  handleError(
    {
      type: "agent:error",
      sessionId,
      error: message,
      errorCode: "STREAM_INTERRUPTED",
      isRetryable: true,
    },
    sessionId,
    ctx
  );
}

/**
 * `agent:session_evicted` — the Rust idle-eviction task removed this session
 * from the in-memory HashMap. If the frontend still thinks the session is
 * running, force it to idle so the UI is not stuck.
 */
export function handleSessionEvicted(
  ctx: EventHandlerContext,
  sessionId?: string
): void {
  resetAllStreamingState(ctx);
  ctx.setStreaming(false);
  clearStreamRetryStatus(ctx, sessionId);
  ctx.onStatusChangeRef.current?.("completed");
}

/**
 * Called by higher-level recovery paths (first successful delta/tool_call
 * after a retry series) to clear the footer pill. Separate from
 * `handleStreamErrorExhausted` because successful recovery takes a different
 * code path — we know the retry worked when real content starts flowing
 * again, not from a dedicated "recovered" event.
 *
 * Also resets the rate-limit hint flag so the next rate-limit episode
 * within the same session can trigger a fresh hint.
 */
export function clearStreamRetryStatus(
  ctx: EventHandlerContext,
  sessionId?: string
): void {
  const store = ctx.getDefaultStore();
  if (!store) return;
  const currentRetry = store.get(streamRetryStatusAtom);
  if (currentRetry && (!sessionId || currentRetry.sessionId === sessionId)) {
    store.set(streamRetryStatusAtom, null);
  }
  _rateLimitHintState.hintShown = false;
  // Clear any in-progress retry block ID so the next independent error
  // in this session gets a fresh block (not merged into the old retry card).
  if (sessionId) {
    _retryBlockId.delete(sessionId);
  }
}
