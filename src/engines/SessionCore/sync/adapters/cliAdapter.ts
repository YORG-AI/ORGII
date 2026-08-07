/**
 * CLI Session Adapter
 *
 * Extracts history loading and real-time event handling from
 * the old useCliSessionSync into a non-hook adapter.
 *
 * History: cli_agent_chunks + cli_agent_status → processChunksRust (Rust pipeline)
 * Events:
 *   - Deltas are accumulated locally for the typewriter effect
 *   - Rust's StreamingBuffer accumulates in parallel and emits
 *     `agent:streaming_complete` with the authoritative final event
 *   - Non-delta chunks (tool_call, user_message, etc.) are normalized via Rust
 */
import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";

import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent/session";
import type { MergeStatus } from "@src/api/tauri/rpc/schemas/validation";
import {
  confirmTurnRunning,
  getTurnGeneration,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { loadSessionAtom } from "@src/engines/SessionCore/core/atoms";
import { isTurnBlockingRuntimeEvent } from "@src/engines/SessionCore/core/runningEventGate";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  normalizeChunkRust,
  processChunksRust,
} from "@src/engines/SessionCore/ingestion/rustBridge";
import { handleInteractionFinalized } from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/toolHandlers";
import {
  createStreamMessageId,
  createStreamThinkingId,
} from "@src/engines/SessionCore/sync/utils/activityIds";
import { createLogger } from "@src/hooks/logger";
import { setSessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
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

import {
  isNativeTranscriptSession,
  registerSessionTranscriptSource,
} from "../nativeTranscriptReconcile";
import type {
  AdapterSendInput,
  EventHandlerCallbacks,
  PostLoadResult,
  RawSessionEvent,
  SessionAdapter,
  SessionEventHandler,
} from "../types";
import {
  makeAssistantEvent,
  makeThinkingEvent,
  makeToolCallEvent,
} from "./shared/eventBuilders";
import { mergeStreamingText } from "./shared/streamTextAccumulator";
import {
  buildToolArgsFromParsed,
  parsePartialToolArgs,
} from "./shared/streamingParsers";
import type { AgentWSEvent, PermissionRequestEvent } from "./shared/types";

const log = createLogger("CliAdapter");

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a streaming event for the live typewriter effect.
 * Uses shared makeAssistantEvent/makeThinkingEvent with CLI-specific fields.
 */
function buildStreamingEvent(
  streamEventId: string,
  sessionId: string,
  content: string,
  kind: "message" | "thinking",
  createdAt: string
): SessionEvent {
  const isMsg = kind === "message";
  const baseEvent = isMsg
    ? makeAssistantEvent(streamEventId, sessionId, content, true)
    : makeThinkingEvent(streamEventId, sessionId, content, true);

  return {
    ...baseEvent,
    createdAt,
    result: isMsg
      ? { content, observation: content, role: "assistant", is_delta: true }
      : { thought: content, content, observation: content, is_delta: true },
  };
}

function convertResultImages(event: SessionEvent): SessionEvent {
  const result = event.result as Record<string, unknown> | undefined;
  if (!result?.images || !Array.isArray(result.images)) return event;
  const converted = (result.images as string[]).map((imgRef) =>
    imgRef.startsWith("data:") ? imgRef : convertFileSrc(imgRef)
  );
  return { ...event, result: { ...result, images: converted } };
}

interface StoredSession {
  status: string;
  errorMessage?: string | null;
  totalTokens?: number;
  /** 'chunks' (legacy DB transcript) or 'native' (CLI's own store). */
  transcriptSource?: string;
}

type CliStatusResponse = {
  status?: CliSessionStatus;
  updatedAt?: string;
};

const CLI_TERMINAL_STATUSES = new Set<CliSessionStatus>([
  "completed",
  "failed",
  "error",
  "cancelled",
  "abandoned",
  "timeout",
  "archived",
]);

const protectedRunningTurnBySession = new Map<
  string,
  { content: string; startedAt: number }
>();

function isCliTerminalStatus(
  status: CliSessionStatus | undefined
): status is CliSessionStatus {
  return status !== undefined && CLI_TERMINAL_STATUSES.has(status);
}

async function readCliStatus(
  sessionId: string
): Promise<CliStatusResponse | null> {
  return (await tauriInvoke("cli_agent_status", {
    sessionId,
  })) as CliStatusResponse | null;
}

async function waitForCliRunBoundary(
  sessionId: string,
  previousStatus: CliStatusResponse | null
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + 15_000;
  const previousUpdatedAt = previousStatus?.updatedAt;
  const previousWasTerminal = isCliTerminalStatus(previousStatus?.status);
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readCliStatus(sessionId);
    const hasNewStatus =
      !previousUpdatedAt || lastStatus?.updatedAt !== previousUpdatedAt;
    const hasDurableBoundary =
      Boolean(previousUpdatedAt) && lastStatus?.updatedAt !== previousUpdatedAt;
    if (lastStatus?.status === "running" && hasNewStatus) {
      return lastStatus;
    }
    if (
      isCliTerminalStatus(lastStatus?.status) &&
      (hasDurableBoundary || !previousWasTerminal)
    ) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `CLI run boundary was not observed for ${sessionId}; lastStatus=${JSON.stringify(lastStatus)}`
  );
}

async function closeObservedCliTerminalEvents(
  sessionId: string,
  status: CliSessionStatus
): Promise<void> {
  const events = await eventStoreProxy.getEvents(sessionId);
  const closableEvents = events.filter((event) => {
    if (event.sessionId && event.sessionId !== sessionId) return false;
    return isTurnBlockingRuntimeEvent(event);
  });
  if (closableEvents.length === 0) return;
  const displayStatus =
    status === "failed" || status === "error" ? "failed" : "completed";
  await Promise.all(
    closableEvents.map((event) =>
      eventStoreProxy.upsert(
        {
          ...event,
          displayStatus,
          activityStatus: "processed",
          result: { ...event.result, status: displayStatus },
          isDelta: false,
        },
        sessionId
      )
    )
  );
}

function markCliRuntimeRunning(sessionId: string): void {
  // FSM running ack is visibility-independent: the dispatch reserved the
  // turn, so promote it to "working" even for background sessions.
  confirmTurnRunning(sessionId);
  if (!isStoreInitialized()) return;
  const store = getInstrumentedStore();
  store.set(setSessionRuntimeStatusAtom, {
    sessionId,
    status: "running",
    source: "sync",
  });
}

function isProtectedCliTurnTerminal(
  sessionId: string,
  status: CliSessionStatus | undefined
): boolean {
  return (
    isCliTerminalStatus(status) && protectedRunningTurnBySession.has(sessionId)
  );
}

function markObservedCliTerminalStatus(
  sessionId: string,
  status: CliSessionStatus | undefined
): void {
  if (!isCliTerminalStatus(status) || !isStoreInitialized()) return;
  if (isProtectedCliTurnTerminal(sessionId, status)) return;
  const store = getInstrumentedStore();
  store.set(setSessionRuntimeStatusAtom, { sessionId, status, source: "sync" });
  void closeObservedCliTerminalEvents(sessionId, status).catch((error) => {
    log.warn("[cliAdapter] failed to close terminal CLI events:", error);
  });
}

async function waitForCliTerminalBoundary(
  sessionId: string,
  previousUpdatedAt: string | null | undefined,
  timeoutMs = 90_000
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readCliStatus(sessionId);
    const hasNewStatus =
      !previousUpdatedAt || lastStatus?.updatedAt !== previousUpdatedAt;
    if (hasNewStatus && isCliTerminalStatus(lastStatus?.status)) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return lastStatus;
}

async function refreshLoadedCliHistory(
  sessionId: string
): Promise<SessionEvent[]> {
  if (!isStoreInitialized()) return [];
  const events = await cliAdapter.loadHistory(
    sessionId,
    new AbortController().signal
  );
  if (events.length === 0) return events;
  // Native-transcript sessions render the live turn from in-memory events
  // only (optimistic synthetic bubble + streamed broadcasts); the replay is
  // read here purely to OBSERVE persistence for the send handshake. Merging
  // it mid-turn would sit replay rows (`codex-user-0`, the synthesized
  // `user-input-*-synthesized` fallback) next to the synthetic bubble under
  // never-matching ids — the ×3 user-bubble bug. The terminal reconcile
  // (scheduleNativeTranscriptReconcile, replace semantics) is the single
  // point where replay becomes the transcript on screen.
  if (!isNativeTranscriptSession(sessionId)) {
    await eventStoreProxy.mergeEvents(events, sessionId);
    getInstrumentedStore().set(loadSessionAtom, { sessionId, events });
  }
  return events;
}

function eventContainsText(event: SessionEvent, text: string): boolean {
  return JSON.stringify(event).includes(text);
}

async function waitForPersistedCliUserEvent(
  sessionId: string,
  content: string
): Promise<SessionEvent[]> {
  const deadline = Date.now() + 15_000;
  let lastEventCount = 0;
  while (Date.now() < deadline) {
    const events = await refreshLoadedCliHistory(sessionId);
    lastEventCount = events.length;
    if (events.some((event) => eventContainsText(event, content)))
      return events;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `CLI user event was not persisted for ${sessionId}; eventCount=${lastEventCount}`
  );
}

function hasRuntimeOutputAfterUserEvent(
  events: SessionEvent[],
  content: string
): boolean {
  let userIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.source === "user" && eventContainsText(event, content)) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return false;
  return events.slice(userIndex + 1).some((event) => event.source !== "user");
}

// ============================================================================
// Adapter
// ============================================================================

export const cliAdapter: SessionAdapter = {
  category: "cli",

  async loadHistory(
    sessionId: string,
    signal: AbortSignal
  ): Promise<SessionEvent[]> {
    const chunks = await tauriInvoke<ActivityChunk[]>("cli_agent_chunks", {
      sessionId,
    });
    if (signal.aborted || !Array.isArray(chunks)) return [];
    const events = await processChunksRust(chunks, sessionId);
    if (signal.aborted) return [];
    return events.map(convertResultImages);
  },

  async postLoad(
    sessionId: string,
    signal: AbortSignal
  ): Promise<PostLoadResult> {
    const result: PostLoadResult = {};
    try {
      const storedSession = await tauriInvoke<StoredSession | null>(
        "cli_agent_status",
        { sessionId }
      );
      if (signal.aborted || !storedSession) return result;

      registerSessionTranscriptSource(
        sessionId,
        storedSession.transcriptSource
      );

      if (typeof storedSession.totalTokens === "number") {
        result.contextTokens = storedSession.totalTokens;
      }

      const status = storedSession.status as CliSessionStatus;
      if (status !== "idle") {
        result.runStatus = status;
        if (
          (status === "failed" || status === "error") &&
          storedSession.errorMessage
        ) {
          result.runError = storedSession.errorMessage;
        }
      }
    } catch (err) {
      log.warn("[CliAdapter] postLoad status fetch failed:", err);
    }
    return result;
  },

  createEventHandler(
    sessionId: string,
    callbacks: EventHandlerCallbacks
  ): SessionEventHandler {
    let _streaming = false;
    let cancelled = false;

    // Lightweight local accumulators for the typewriter effect only.
    // Rust's StreamingBuffer is the authoritative source; these are
    // replaced when `agent:streaming_complete` arrives.
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
      if (_streaming !== active) {
        _streaming = active;
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
            if (
              protectedRunningTurnBySession.get(sessionId) !== protectedTurn
            ) {
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
    // broadcast (no paired exit_plan_mode), so the pending atom must be
    // cleared here or the Build card stays pinned on CLI sessions too.
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
        .catch((err) => {
          log.warn("[CliAdapter] normalizeChunkRust failed:", err);
        });
      return true;
    }

    function handleToolCallDeltaActivity(chunk: ActivityChunk): void {
      setStreamingMode(true);
      const indexValue = chunk.result?.index;
      const index = typeof indexValue === "number" ? indexValue : 0;
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
        argsJson: existing.argsJson + argumentsDelta,
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

      if (cancelled) {
        cancelled = false;
      }

      const isDelta = chunk.result?.is_delta === true;
      const actionType = chunk.action_type;

      if (handlePlanApprovalActivity(chunk)) {
        return;
      }

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

      // ── Delta: accumulate locally for the typewriter effect ──
      // Rust's StreamingBuffer accumulates in parallel and will emit
      // agent:streaming_complete with the authoritative final content.
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
        msgContent = mergeStreamingText(msgContent, deltaText);
        eventStoreProxy.upsert(
          buildStreamingEvent(
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
        thinkContent = mergeStreamingText(thinkContent, deltaText);
        eventStoreProxy.upsert(
          buildStreamingEvent(
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

      // ── Completion chunks (is_delta !== true) for message/thinking ──
      // Rust usually follows deltas with `agent:streaming_complete`, but some
      // CLI streams also emit a final activity chunk. If a TS placeholder is
      // already visible, replace it with the finalized event instead of
      // appending a duplicate assistant/thinking message.
      if (isMessageType || isThinkingType) {
        const tempId = isMessageType ? msgStreamId : thinkStreamId;
        const isFinalAssistantMessage =
          isMessageType && chunk.result?.is_full_content === true;
        const reconcileAfterFinalEvent = () => {
          reconcileTerminalEventsIfNeeded();
          if (isFinalAssistantMessage) {
            scheduleFinalAssistantSettleFallback();
          }
        };
        normalizeChunkRust(chunk, sessionId)
          .then((event) => {
            if (finalizedStreamEventIds.has(event.id)) return;
            if (tempId && tempId !== event.id) {
              if (isMessageType) {
                clearMessageStream();
              } else {
                clearThinkingStream();
              }
              finalizedStreamEventIds.add(event.id);
              eventStoreProxy
                .replaceAndRemove(tempId, event, sessionId)
                .then(reconcileAfterFinalEvent);
              return;
            }
            eventStoreProxy
              .append([event], sessionId)
              .then(reconcileAfterFinalEvent);
          })
          .catch((err) => {
            log.warn("[CliAdapter] normalizeChunkRust failed:", err);
          });
        return;
      }

      // ── Normal (non-delta) activity: tool_call, user_message, etc. ──
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
        .catch((err) => {
          log.warn("[CliAdapter] normalizeChunkRust failed:", err);
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
      finalizedStreamEventIds.add(completeEvent.id);

      // Streaming stays true through tool execution — only terminal
      // status (completed/failed/error/cancelled) or reset turns it off.

      if (streamType === "message") {
        const tsTempId = msgStreamId;
        clearMessageStream();
        const reconcileAfterCompleteMessage = () => {
          reconcileTerminalEventsIfNeeded();
          scheduleFinalAssistantSettleFallback();
        };
        // Remove the TS-side placeholder and insert Rust's authoritative event atomically.
        // The TS placeholder has a per-turn unique ID (stream-msg-ts-*) to avoid
        // overwriting the previous turn's completed assistant message. If they differ,
        // swap them; if they happen to be the same (no delta arrived), just upsert.
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
        if (status === "cancelled") {
          cancelled = true;
        }
        callbacks.onAgentComplete?.();
      }

      if (status === "running") {
        observedTerminalStatus = undefined;
        protectedRunningTurnBySession.delete(sessionId);
        cancelled = false;
      }
    }

    function handleTokenUpdate(totalTokens: number): void {
      callbacks.onTokenUpdate?.(totalTokens);
    }

    /**
     * `permission:request` with `origin: "cli_hook"` or `"acp"` — a
     * managed CLI session's PermissionRequest hook (Claude) or an ACP
     * agent's `session/request_permission` (OpenCode/Copilot/Kiro) is
     * parked on the backend waiting for the user. Mirror of the
     * Rust-agent adapter's handlePermissionRequest: dispatch the window
     * CustomEvent that PermissionCard consumes, tagged so its response
     * routes back to the CLI registries (`cli_agent_approval_response`)
     * instead of `agent_permission_response`.
     */
    function handleCliPermissionRequest(raw: RawSessionEvent): void {
      const origin = raw.origin;
      if (origin !== "cli_hook" && origin !== "acp") return;
      const requestId = rawString(raw, "requestId");
      if (!requestId) return;
      const permEvent: PermissionRequestEvent = {
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
      window.dispatchEvent(
        new CustomEvent("agent-permission-request", { detail: permEvent })
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
          if (typeof total === "number") {
            handleTokenUpdate(total);
          }
        } else if (raw.type === "code_session.worktree_created") {
          // Worktree creation tracking
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
          // Merge result tracking
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
        _streaming = false;
        eventStoreProxy.setStreaming(false, sessionId);
      },

      get isStreaming(): boolean {
        return _streaming;
      },

      dispose(): void {
        this.reset();
      },
    };
  },

  async sendMessage(input: AdapterSendInput): Promise<void> {
    const {
      sessionId,
      content,
      model,
      accountId,
      mode,
      imageDataUrls,
      adeContext,
      isResume,
    } = input;
    if (!isResume && content.trim()) {
      await enterAgentOrgSessionIntervention(sessionId);
    }
    const previousStatus = await readCliStatus(sessionId);
    protectedRunningTurnBySession.set(sessionId, {
      content,
      startedAt: Date.now(),
    });
    markCliRuntimeRunning(sessionId);
    try {
      await tauriInvoke("cli_agent_message", {
        sessionId,
        content,
        ...(model ? { model } : {}),
        ...(accountId ? { accountId } : {}),
        ...(mode ? { mode } : {}),
        ...(imageDataUrls && imageDataUrls.length > 0
          ? { images: imageDataUrls }
          : {}),
        ...(adeContext ? { ideContext: adeContext } : {}),
      });
    } catch (error) {
      protectedRunningTurnBySession.delete(sessionId);
      throw error;
    }
    const acceptedStatus = await waitForCliRunBoundary(
      sessionId,
      previousStatus
    );
    markCliRuntimeRunning(sessionId);
    // Capture the FSM generation of THIS dispatch so the async terminal
    // observers below can never close a newer turn (late-terminal safety).
    const dispatchGeneration = getTurnGeneration(sessionId);
    const persistedEvents = await waitForPersistedCliUserEvent(
      sessionId,
      content
    );
    const acceptedTerminalIsCurrentTurn =
      isCliTerminalStatus(acceptedStatus?.status) &&
      hasRuntimeOutputAfterUserEvent(persistedEvents, content);
    if (acceptedTerminalIsCurrentTurn) {
      protectedRunningTurnBySession.delete(sessionId);
      markObservedCliTerminalStatus(sessionId, acceptedStatus.status);
      markTurnTerminal(
        sessionId,
        toTurnTerminalStatus(acceptedStatus?.status ?? "completed"),
        { generation: dispatchGeneration }
      );
    } else {
      void waitForCliTerminalBoundary(
        sessionId,
        acceptedStatus?.updatedAt ?? previousStatus?.updatedAt
      ).then((terminalStatus) => {
        if (isCliTerminalStatus(terminalStatus?.status)) {
          protectedRunningTurnBySession.delete(sessionId);
          markObservedCliTerminalStatus(sessionId, terminalStatus.status);
          markTurnTerminal(
            sessionId,
            toTurnTerminalStatus(terminalStatus.status),
            { generation: dispatchGeneration }
          );
        }
      });
    }
  },

  async stopSession(sessionId: string, reason: CancelReason): Promise<void> {
    await tauriInvoke("cli_agent_cancel", { sessionId, reason });
  },
};
