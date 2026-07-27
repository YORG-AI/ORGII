import type { MergeStatus } from "@src/api/tauri/rpc/schemas/validation";
import {
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { normalizeChunkRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { handleInteractionFinalized } from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/toolHandlers";
import {
  createStreamMessageId,
  createStreamThinkingId,
} from "@src/engines/SessionCore/sync/utils/activityIds";
import { createLogger } from "@src/hooks/logger";
import {
  pendingPermissionRequestsAtom,
  upsertPendingPermissionRequest,
} from "@src/store/session/permissionRequestAtom";
import {
  clearPendingPlanApproval,
  pendingPlanApprovalsAtom,
  upsertPendingPlanApproval,
} from "@src/store/session/planApprovalAtom";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import type {
  ActivityChunk,
  CliSessionStatus,
} from "@src/types/session/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { isSessionRuntimeExecuting } from "@src/util/session/sessionRuntimeExecuting";

import type {
  EventHandlerCallbacks,
  RawSessionEvent,
  SessionEventHandler,
} from "../../types";
import { makeToolCallEvent } from "../shared/eventBuilders";
import {
  appendBoundedToolCallArgs,
  makeRoomForToolCallDelta,
  mergeStreamingText,
} from "../shared/streamTextAccumulator";
import {
  buildToolArgsFromParsed,
  parsePartialToolArgs,
} from "../shared/streamingParsers";
import { capStreamContent } from "../shared/subagentTracking";
import type { AgentWSEvent, PermissionRequestEvent } from "../shared/types";
import {
  isCliTerminalStatus,
  isProtectedCliTurnTerminal,
  markCliRuntimeRunning,
  markObservedCliTerminalStatus,
  protectedRunningTurnBySession,
  readCliStatus,
} from "./cliLifecycle";
import { buildCliStreamingEvent } from "./streamingEvent";

const log = createLogger("CliAdapter");
const MAX_FINALIZED_STREAM_IDS = 256;

export function createCliEventHandler(
  sessionId: string,
  callbacks: EventHandlerCallbacks
): SessionEventHandler {
  let streaming = false;
  let cancelled = false;

  // Lightweight local accumulators for the typewriter effect only.
  // Rust's StreamingBuffer is authoritative and replaces these when
  // `agent:streaming_complete` arrives.
  let msgContent = "";
  let msgStreamId = "";
  let msgStartedAt = "";
  let thinkContent = "";
  let thinkStreamId = "";
  let thinkStartedAt = "";
  let observedTerminalStatus: CliSessionStatus | undefined;
  let finalAssistantSettleTimer: ReturnType<typeof setTimeout> | undefined;
  const finalizedStreamEventIds = new Set<string>();
  const toolCallDeltaBuffers = new Map<
    number,
    { toolCallId?: string; toolName?: string; argsJson: string }
  >();

  function setStreamingMode(active: boolean): void {
    if (streaming !== active) {
      streaming = active;
      eventStoreProxy.setStreaming(active, sessionId);
    }
  }

  function clearMessageStream(): void {
    msgContent = "";
    msgStreamId = "";
    msgStartedAt = "";
  }

  function clearThinkingStream(): void {
    thinkContent = "";
    thinkStreamId = "";
    thinkStartedAt = "";
  }

  function clearToolCallDeltaBuffers(): void {
    toolCallDeltaBuffers.clear();
  }

  function clearFinalAssistantSettleTimer(): void {
    if (!finalAssistantSettleTimer) return;
    clearTimeout(finalAssistantSettleTimer);
    finalAssistantSettleTimer = undefined;
  }

  function rememberFinalizedStreamEvent(eventId: string): void {
    if (finalizedStreamEventIds.has(eventId)) return;
    while (finalizedStreamEventIds.size >= MAX_FINALIZED_STREAM_IDS) {
      const oldestId = finalizedStreamEventIds.values().next().value;
      if (oldestId === undefined) break;
      finalizedStreamEventIds.delete(oldestId);
    }
    finalizedStreamEventIds.add(eventId);
  }

  function reconcileTerminalEventsIfNeeded(): void {
    if (!observedTerminalStatus) return;
    clearFinalAssistantSettleTimer();
    markObservedCliTerminalStatus(sessionId, observedTerminalStatus);
  }

  function scheduleFinalAssistantSettleFallback(): void {
    if (observedTerminalStatus) return;
    const protectedTurn = protectedRunningTurnBySession.get(sessionId);
    if (!protectedTurn) return;
    clearFinalAssistantSettleTimer();
    finalAssistantSettleTimer = setTimeout(() => {
      if (observedTerminalStatus) return;
      if (protectedRunningTurnBySession.get(sessionId) !== protectedTurn) {
        return;
      }
      void readCliStatus(sessionId)
        .then((statusResponse) => {
          if (observedTerminalStatus) return;
          if (protectedRunningTurnBySession.get(sessionId) !== protectedTurn) {
            return;
          }
          const terminalStatus = isCliTerminalStatus(statusResponse?.status)
            ? statusResponse.status
            : "completed";
          observedTerminalStatus = terminalStatus;
          protectedRunningTurnBySession.delete(sessionId);
          callbacks.onStatusChange?.(terminalStatus);
          markObservedCliTerminalStatus(sessionId, terminalStatus);
          markTurnTerminal(sessionId, toTurnTerminalStatus(terminalStatus));
          clearMessageStream();
          clearThinkingStream();
          clearToolCallDeltaBuffers();
          setStreamingMode(false);
          callbacks.onAgentComplete?.();
        })
        .catch((error) => {
          log.warn(
            "[CliAdapter] final assistant settle fallback failed:",
            error
          );
        });
    }, 1_500);
  }

  function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function getStore() {
    return isStoreInitialized() ? getInstrumentedStore() : null;
  }

  function rawString(raw: RawSessionEvent, key: string): string | undefined {
    const value = raw[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function rawNumber(raw: RawSessionEvent, key: string): number | null {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function handlePlanReadyForApproval(raw: RawSessionEvent): void {
    const store = getStore();
    if (!store) return;
    const planPath = rawString(raw, "planPath");
    if (!planPath) return;
    store.set(pendingPlanApprovalsAtom, (prev) =>
      upsertPendingPlanApproval(prev, {
        sessionId,
        planPath,
        planTitle: rawString(raw, "planTitle") ?? "",
        planContent: rawString(raw, "planContent") ?? "",
        toolCallId: rawString(raw, "toolCallId"),
        planId: rawString(raw, "planId"),
        planRevisionId: rawString(raw, "planRevisionId"),
        originToolCallId: rawString(raw, "originToolCallId"),
        autoApproveAt: rawNumber(raw, "autoApproveAt"),
      })
    );
  }

  function handleExitPlanMode(raw: RawSessionEvent): void {
    const store = getStore();
    if (!store) return;
    store.set(pendingPlanApprovalsAtom, (prev) =>
      clearPendingPlanApproval(prev, sessionId, rawString(raw, "toolCallId"))
    );
  }

  // Abandoned / orphaned / superseded resolutions arrive only as this
  // broadcast (no paired exit_plan_mode), so clear the pending Build card.
  function handlePlanApprovalArchivedBroadcast(raw: RawSessionEvent): void {
    const store = getStore();
    if (!store) return;
    store.set(pendingPlanApprovalsAtom, (prev) =>
      clearPendingPlanApproval(
        prev,
        sessionId,
        rawString(raw, "planRevisionId") ?? rawString(raw, "toolCallId")
      )
    );
  }

  function handlePlanApprovalActivity(chunk: ActivityChunk): boolean {
    if (chunk.action_type !== "plan_approval") return false;
    const store = getStore();
    if (!store) return true;
    const args = chunk.args ?? {};
    const planPath = asString(args.planPath);
    if (!planPath) return true;
    store.set(pendingPlanApprovalsAtom, (prev) =>
      upsertPendingPlanApproval(prev, {
        sessionId,
        planPath,
        planTitle: asString(args.title) ?? "",
        planContent: asString(args.content) ?? "",
        toolCallId: asString(args.planRevisionId),
        planId: asString(args.planId),
        planRevisionId: asString(args.planRevisionId),
        originToolCallId: asString(args.originToolCallId),
        autoApproveAt: asNumber(args.autoApproveAt),
      })
    );
    normalizeChunkRust(chunk, sessionId)
      .then((event) => {
        eventStoreProxy.upsert(event, sessionId);
      })
      .catch((error) => {
        log.warn("[CliAdapter] normalizeChunkRust failed:", error);
      });
    return true;
  }

  function handleToolCallDeltaActivity(chunk: ActivityChunk): void {
    setStreamingMode(true);
    const indexValue = chunk.result?.index;
    const index = typeof indexValue === "number" ? indexValue : 0;
    makeRoomForToolCallDelta(toolCallDeltaBuffers, index);
    const existing = toolCallDeltaBuffers.get(index) ?? { argsJson: "" };
    const toolCallId =
      asString(chunk.result?.tool_call_id) ??
      asString(chunk.result?.toolCallId) ??
      existing.toolCallId;
    const toolName =
      asString(chunk.result?.tool_name) ??
      asString(chunk.result?.toolName) ??
      existing.toolName;
    const argumentsDelta =
      asString(chunk.result?.arguments_delta) ??
      asString(chunk.result?.argumentsDelta) ??
      "";
    const nextBuffer = {
      toolCallId,
      toolName,
      argsJson: appendBoundedToolCallArgs(existing.argsJson, argumentsDelta),
    };
    toolCallDeltaBuffers.set(index, nextBuffer);

    if (!nextBuffer.toolCallId) return;

    const parsed = parsePartialToolArgs(nextBuffer.argsJson);
    const args = buildToolArgsFromParsed(parsed);
    eventStoreProxy.upsert(
      makeToolCallEvent(
        `tool-call-${nextBuffer.toolCallId}`,
        sessionId,
        nextBuffer.toolName,
        nextBuffer.toolCallId,
        args,
        true
      ),
      sessionId
    );
  }

  function handleActivity(chunk: ActivityChunk): void {
    if (!observedTerminalStatus) {
      callbacks.onStatusChange?.("running");
    }

    if (
      chunk.function === "user_message" &&
      (chunk.action_type === "raw" || chunk.action_type === "raw_event")
    ) {
      return;
    }

    if (cancelled) cancelled = false;

    const isDelta = chunk.result?.is_delta === true;
    const actionType = chunk.action_type;

    if (handlePlanApprovalActivity(chunk)) return;

    const isMessageType =
      actionType === "assistant" ||
      actionType === "assistant_delta" ||
      actionType === "message" ||
      actionType === "message_delta";
    const isThinkingType =
      actionType === "llm_thinking" || actionType === "llm_thinking_delta";

    if (actionType === "tool_call_delta") {
      handleToolCallDeltaActivity(chunk);
      return;
    }

    if (isDelta && isMessageType) {
      setStreamingMode(true);
      const deltaText =
        (chunk.result?.content as string) ||
        (chunk.result?.observation as string) ||
        "";
      if (!msgStreamId) {
        msgStreamId = createStreamMessageId(sessionId);
        msgStartedAt = chunk.created_at || new Date().toISOString();
      }
      msgContent = capStreamContent(mergeStreamingText(msgContent, deltaText));
      eventStoreProxy.upsert(
        buildCliStreamingEvent(
          msgStreamId,
          sessionId,
          msgContent,
          "message",
          msgStartedAt
        ),
        sessionId
      );
      return;
    }

    if (isDelta && isThinkingType) {
      setStreamingMode(true);
      const deltaText =
        (chunk.result?.thought as string) ||
        (chunk.result?.content as string) ||
        (chunk.result?.observation as string) ||
        "";
      if (!thinkStreamId) {
        thinkStreamId = createStreamThinkingId(sessionId);
        thinkStartedAt = chunk.created_at || new Date().toISOString();
      }
      thinkContent = capStreamContent(
        mergeStreamingText(thinkContent, deltaText)
      );
      eventStoreProxy.upsert(
        buildCliStreamingEvent(
          thinkStreamId,
          sessionId,
          thinkContent,
          "thinking",
          thinkStartedAt
        ),
        sessionId
      );
      return;
    }

    // Final message/thinking chunks replace any TS typewriter placeholder.
    if (isMessageType || isThinkingType) {
      const tempId = isMessageType ? msgStreamId : thinkStreamId;
      const isFinalAssistantMessage =
        isMessageType && chunk.result?.is_full_content === true;
      const reconcileAfterFinalEvent = () => {
        reconcileTerminalEventsIfNeeded();
        if (isFinalAssistantMessage) scheduleFinalAssistantSettleFallback();
      };
      normalizeChunkRust(chunk, sessionId)
        .then((event) => {
          if (finalizedStreamEventIds.has(event.id)) return;
          if (tempId && tempId !== event.id) {
            if (isMessageType) clearMessageStream();
            else clearThinkingStream();
            rememberFinalizedStreamEvent(event.id);
            eventStoreProxy
              .replaceAndRemove(tempId, event, sessionId)
              .then(reconcileAfterFinalEvent);
            return;
          }
          eventStoreProxy
            .append([event], sessionId)
            .then(reconcileAfterFinalEvent);
        })
        .catch((error) => {
          log.warn("[CliAdapter] normalizeChunkRust failed:", error);
        });
      return;
    }

    normalizeChunkRust(chunk, sessionId)
      .then((event) => {
        if (actionType === "tool_call") {
          for (const [index, buffer] of toolCallDeltaBuffers.entries()) {
            if (buffer.toolCallId && buffer.toolCallId === event.callId) {
              toolCallDeltaBuffers.delete(index);
            }
          }
          eventStoreProxy
            .upsert(event, sessionId)
            .then(reconcileTerminalEventsIfNeeded);
          return;
        }
        eventStoreProxy
          .append([event], sessionId)
          .then(reconcileTerminalEventsIfNeeded);
      })
      .catch((error) => {
        log.warn("[CliAdapter] normalizeChunkRust failed:", error);
      });
  }

  function handleStreamingComplete(raw: RawSessionEvent): void {
    const payload = raw.payload as Record<string, unknown> | undefined;
    const completeEvent = payload?.event as SessionEvent | undefined;
    const streamType = payload?.streamType as "message" | "thinking";

    if (!completeEvent) {
      log.warn("[CliAdapter] streaming_complete missing event payload");
      return;
    }
    if (finalizedStreamEventIds.has(completeEvent.id)) return;
    rememberFinalizedStreamEvent(completeEvent.id);

    if (streamType === "message") {
      const tsTempId = msgStreamId;
      clearMessageStream();
      const reconcileAfterCompleteMessage = () => {
        reconcileTerminalEventsIfNeeded();
        scheduleFinalAssistantSettleFallback();
      };
      if (tsTempId && tsTempId !== completeEvent.id) {
        eventStoreProxy
          .replaceAndRemove(tsTempId, completeEvent, sessionId)
          .then(reconcileAfterCompleteMessage);
      } else {
        eventStoreProxy
          .upsert(completeEvent, sessionId)
          .then(reconcileAfterCompleteMessage);
      }
    } else if (streamType === "thinking") {
      const tsTempId = thinkStreamId;
      clearThinkingStream();
      if (tsTempId && tsTempId !== completeEvent.id) {
        eventStoreProxy
          .replaceAndRemove(tsTempId, completeEvent, sessionId)
          .then(reconcileTerminalEventsIfNeeded);
      } else {
        eventStoreProxy
          .upsert(completeEvent, sessionId)
          .then(reconcileTerminalEventsIfNeeded);
      }
    } else {
      eventStoreProxy
        .upsert(completeEvent, sessionId)
        .then(reconcileTerminalEventsIfNeeded);
    }
  }

  function handleStatusChange(status: string, errorMessage?: string): void {
    const terminalStatus = isCliTerminalStatus(status as CliSessionStatus)
      ? (status as CliSessionStatus)
      : undefined;
    if (isProtectedCliTurnTerminal(sessionId, terminalStatus)) {
      markCliRuntimeRunning(sessionId);
      return;
    }

    callbacks.onStatusChange?.(status, errorMessage);

    if (terminalStatus) {
      observedTerminalStatus = terminalStatus;
      clearFinalAssistantSettleTimer();
      clearMessageStream();
      clearThinkingStream();
      clearToolCallDeltaBuffers();
      setStreamingMode(false);
      markObservedCliTerminalStatus(sessionId, observedTerminalStatus);
      if (status === "cancelled") cancelled = true;
      callbacks.onAgentComplete?.();
    }

    if (isSessionRuntimeExecuting(status)) {
      observedTerminalStatus = undefined;
      protectedRunningTurnBySession.delete(sessionId);
      cancelled = false;
    }
  }

  function handleCliPermissionRequest(raw: RawSessionEvent): void {
    const origin = raw.origin;
    if (origin !== "cli_hook" && origin !== "acp") return;
    const requestId = rawString(raw, "requestId");
    if (!requestId) return;
    const permissionEvent: PermissionRequestEvent = {
      requestId,
      sessionId,
      tool: rawString(raw, "toolName") ?? rawString(raw, "tool") ?? "unknown",
      toolCallId: rawString(raw, "toolCallId"),
      args:
        raw.toolArgs && typeof raw.toolArgs === "object"
          ? (raw.toolArgs as Record<string, unknown>)
          : {},
      origin,
    };
    getStore()?.set(pendingPermissionRequestsAtom, (prev) =>
      upsertPendingPermissionRequest(prev, permissionEvent)
    );
  }

  return {
    handleEvent(raw: RawSessionEvent): void {
      const msgSessionId =
        (raw.session_id as string) || (raw.sessionId as string);
      if (msgSessionId !== sessionId) return;

      if (raw.type === "agent:interaction_finalized") {
        handleInteractionFinalized(raw as unknown as AgentWSEvent, sessionId);
      } else if (raw.type === "permission:request") {
        handleCliPermissionRequest(raw);
      } else if (raw.type === "agent:plan_ready_for_approval") {
        handlePlanReadyForApproval(raw);
      } else if (raw.type === "agent:exit_plan_mode") {
        handleExitPlanMode(raw);
      } else if (raw.type === "agent:plan_approval_archived") {
        handlePlanApprovalArchivedBroadcast(raw);
      } else if (raw.type === "code_session.activity" && raw.chunk) {
        handleActivity(raw.chunk as unknown as ActivityChunk);
      } else if (raw.type === "agent:streaming_complete") {
        handleStreamingComplete(raw);
      } else if (raw.type === "code_session.status_changed") {
        handleStatusChange(
          raw.status as string,
          raw.error_message as string | undefined
        );
      } else if (raw.type === "code_session.token_usage_updated") {
        const total = raw.total_tokens;
        if (typeof total === "number") callbacks.onTokenUpdate?.(total);
      } else if (raw.type === "code_session.worktree_created") {
        upsertSession({
          session_id: msgSessionId,
          worktreePath: raw.worktree_path as string | undefined,
          worktreeBranch: raw.branch as string | undefined,
          baseBranch: raw.base_branch as string | undefined,
          mergeStatus: "pending",
          created_at: "",
          updated_at: "",
          status: "pending",
        });
      } else if (raw.type === "code_session.merge_result") {
        const status = raw.status as MergeStatus | undefined;
        if (status) {
          upsertSession({
            session_id: msgSessionId,
            mergeStatus: status,
            created_at: "",
            updated_at: "",
            status: "completed",
          });
        }
      }
    },

    reset(): void {
      clearFinalAssistantSettleTimer();
      clearMessageStream();
      clearThinkingStream();
      clearToolCallDeltaBuffers();
      observedTerminalStatus = undefined;
      cancelled = false;
      streaming = false;
      eventStoreProxy.setStreaming(false, sessionId);
    },

    get isStreaming(): boolean {
      return streaming;
    },

    dispose(): void {
      this.reset();
    },
  };
}
