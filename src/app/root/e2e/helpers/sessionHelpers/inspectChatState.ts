import { invoke } from "@tauri-apps/api/core";

import { processChatItems } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline";
import { sessionIdAtom } from "@src/engines/SessionCore";
import {
  getTurnGeneration,
  getTurnPhase,
} from "@src/engines/SessionCore/control/turnLifecycle";
import {
  derivedSnapshotAtom,
  sortedEventsAtom,
  streamingDeltaContentAtom,
} from "@src/engines/SessionCore/core/atoms/events";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { chatEventsAtom } from "@src/engines/SessionCore/derived/chatEvents";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRuntimeErrorAtom,
  sessionRuntimeStatusAtom,
  userInitiatedCancelAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { externalReplayTurnSummariesAtomFamily } from "@src/store/session/externalReplayTurnSummariesAtom";
import {
  fileReviewMapAtom,
  pendingReviewCountAtom,
} from "@src/store/session/fileReviewAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import {
  activeSessionIdAtom,
  sessionViewAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  type QueuedMessage,
  messageQueueAtom,
  queueEditingAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { todosAtom } from "@src/store/ui/todoAtom";

import { asError } from "../../result";
import type { E2EStore, Json, Result } from "../../types";

export function createInspectChatStateHelper(store: E2EStore) {
  return async (): Promise<
    Result<{
      activeSessionId: string | null;
      activeSession: Json | null;
      workstationActiveSessionId: string | null;
      sessionView: Json;
      coreSessionId: string | null;
      stationMode: "my-station" | "agent-station";
      chatPanelMaximized: boolean;
      snapshotEventCount: number;
      snapshotChatEventCount: number;
      proxySnapshotEventCount: number;
      proxySnapshotChatEventCount: number;
      proxySnapshotChatEventIds: string[];
      externalReplayTurnSummaryCount: number;
      externalReplayTurnSummarySamples: Array<{
        turnIndex: number;
        turnId: string;
        renderedUserEventId: string | null;
        userPreview: string;
      }>;
      chatEventCount: number;
      chatEventIds: string[];
      runtimeStatus: string;
      runtimeError: string | null;
      isSessionActive: boolean;
      isPendingCancel: boolean;
      isQueueEditing: boolean;
      userInitiatedCancel: boolean;
      turnPhase: string;
      turnGeneration: number;
      queueFlushRequest: number;
      queuedMessages: Array<{
        id: string;
        sessionId: string;
        content: string;
        imageCount: number;
      }>;
      forceSendPendingMessages: Array<{
        id: string;
        sessionId: string;
        content: string;
      }>;
      fileReviewCount: number;
      pendingReviewCount: number;
      pendingPlan: Json | null;
      pinnedTodoCount: number;
      snapshotCount: number | null;
      fileChangesCount: number | null;
      fileChangePaths: string[] | null;
      toolEvents: Array<{
        id: string;
        actionType: string;
        uiCanonical: string;
        functionName: string;
      }>;
      rawEvents: Array<{
        id: string;
        source: string;
        createdAt: string;
        actionType: string;
        uiCanonical: string;
        functionName: string;
        displayText: string;
        displayStatus: string;
        activityStatus: string;
        isDelta: boolean | null;
        resultStatus: string | null;
        planRevisionId: string | null;
        args: Json;
        result: Json;
      }>;
      chatEvents: Array<{
        id: string;
        source: string;
        createdAt: string;
        actionType: string;
        uiCanonical: string;
        functionName: string;
        displayText: string;
        displayStatus: string;
        displayVariant: string;
        args: Json;
      }>;
      streamingDelta: {
        length: number;
        text: string;
      } | null;
      pipelineItems: Array<{
        type: string;
        eventId: string | null;
        functionName: string;
        uiCanonical: string;
        actionType: string;
      }>;
      pipelineStats: Json;
    }>
  > => {
    try {
      const snapshot = store.get(derivedSnapshotAtom);
      const chatEvents = store.get(chatEventsAtom);
      const { items: pipelineItems, stats: pipelineStats } =
        processChatItems(chatEvents);
      const events = store.get(sortedEventsAtom);
      const serializeQueuedMessage = (message: QueuedMessage) => ({
        id: message.id,
        sessionId: message.sessionId,
        content: message.content,
        priority: message.priority,
        requiresExplicitDispatch: message.requiresExplicitDispatch ?? false,
        createdAt: message.createdAt,
        imageCount: message.imageDataUrls?.length ?? 0,
      });
      const queue = store.get(messageQueueAtom);
      const queuedMessages = queue.map(serializeQueuedMessage);
      // Explicit "now" dispatches awaiting the FSM — the unified-queue
      // equivalent of the old forceSendPendingQueueAtom.
      const forceSendPendingMessages = queue
        .filter((message) => message.priority === "now")
        .map(serializeQueuedMessage);
      const activeSessionId = store.get(activeSessionIdAtom);
      const proxySnapshot = activeSessionId
        ? eventStoreProxy.getLatestSessionSnapshot(activeSessionId)
        : null;
      const externalReplayTurnSummaries = activeSessionId
        ? store.get(externalReplayTurnSummariesAtomFamily(activeSessionId))
        : [];
      const summarySampleIndices = Array.from(
        new Set(
          [
            0,
            1,
            externalReplayTurnSummaries.length - 3,
            externalReplayTurnSummaries.length - 2,
            externalReplayTurnSummaries.length - 1,
          ].filter(
            (index) => index >= 0 && index < externalReplayTurnSummaries.length
          )
        )
      );
      const activeSession = activeSessionId
        ? (store
            .get(sessionsAtom)
            .find((session) => session.session_id === activeSessionId) ?? null)
        : null;
      const streamingDelta = activeSessionId
        ? store.get(streamingDeltaContentAtom).get(activeSessionId)
        : undefined;
      const streamingDeltaText = streamingDelta?.content ?? "";
      let snapshotCount: number | null = null;
      let fileChangesCount: number | null = null;
      let fileChangePaths: string[] | null = null;
      if (activeSessionId) {
        try {
          const snapshots = await invoke<unknown[]>("agent_get_snapshots", {
            sessionId: activeSessionId,
          });
          snapshotCount = snapshots.length;
        } catch {
          snapshotCount = null;
        }
        try {
          const fileChanges = await invoke<Array<{ path?: unknown }>>(
            "agent_get_session_files",
            { sessionId: activeSessionId }
          );
          fileChangesCount = fileChanges.length;
          fileChangePaths = fileChanges.map((file) => String(file.path ?? ""));
        } catch {
          fileChangesCount = null;
          fileChangePaths = null;
        }
      }
      return {
        ok: true,
        activeSessionId,
        activeSession: activeSession
          ? ({
              id: activeSession.session_id,
              category: activeSession.category,
              model: activeSession.model,
              accountId: activeSession.accountId,
              keySource: activeSession.keySource,
              cliAgentType: activeSession.cliAgentType,
              agentExecMode: activeSession.agentExecMode,
            } as unknown as Json)
          : null,
        workstationActiveSessionId: store.get(workstationActiveSessionIdAtom),
        sessionView: store.get(sessionViewAtom) as unknown as Json,
        coreSessionId: store.get(sessionIdAtom),
        stationMode: store.get(stationModeAtom),
        chatPanelMaximized: store.get(chatPanelMaximizedAtom),
        snapshotEventCount: snapshot?.eventCount ?? 0,
        snapshotChatEventCount: snapshot?.chatEvents.length ?? 0,
        proxySnapshotEventCount: proxySnapshot?.eventCount ?? 0,
        proxySnapshotChatEventCount: proxySnapshot?.chatEvents.length ?? 0,
        proxySnapshotChatEventIds:
          proxySnapshot?.chatEvents.map((event) => event.id) ?? [],
        externalReplayTurnSummaryCount: externalReplayTurnSummaries.length,
        externalReplayTurnSummarySamples: summarySampleIndices.map(
          (turnIndex) => {
            const summary = externalReplayTurnSummaries[turnIndex];
            return {
              turnIndex,
              turnId: summary?.turnId ?? "",
              renderedUserEventId: summary?.renderedUserEventId ?? null,
              userPreview: summary?.userPreview ?? "",
            };
          }
        ),
        chatEventCount: chatEvents.length,
        chatEventIds: chatEvents.map((event) => event.id),
        runtimeStatus: store.get(sessionRuntimeStatusAtom),
        runtimeError: store.get(sessionRuntimeErrorAtom),
        isSessionActive: store.get(isSessionActiveAtom),
        isPendingCancel: store.get(isPendingCancelAtom),
        isQueueEditing: store.get(queueEditingAtom),
        userInitiatedCancel: store.get(userInitiatedCancelAtom),
        turnPhase: activeSessionId ? getTurnPhase(activeSessionId) : "idle",
        turnGeneration: activeSessionId
          ? getTurnGeneration(activeSessionId)
          : 0,
        queueFlushRequest: store.get(queueFlushRequestAtom),
        queuedMessages,
        forceSendPendingMessages,
        fileReviewCount: store.get(fileReviewMapAtom).size,
        pendingReviewCount: store.get(pendingReviewCountAtom),
        pendingPlan: activeSessionId
          ? ((store.get(pendingPlanApprovalsAtom).get(activeSessionId)
              ?.current as unknown as Json | null) ?? null)
          : null,
        pinnedTodoCount: store.get(todosAtom).length,
        snapshotCount,
        fileChangesCount,
        fileChangePaths,
        toolEvents: events
          .filter((event) => event.actionType === "tool_call")
          .map((event) => ({
            id: event.id,
            actionType: event.actionType,
            uiCanonical: event.uiCanonical,
            functionName: event.functionName,
          })),
        rawEvents: events.map((event) => ({
          id: event.id,
          source: event.source,
          createdAt: event.createdAt,
          actionType: event.actionType,
          uiCanonical: event.uiCanonical,
          functionName: event.functionName,
          displayText: event.displayText,
          displayStatus: event.displayStatus,
          activityStatus: event.activityStatus,
          isDelta: event.isDelta ?? null,
          resultStatus:
            typeof event.result?.status === "string"
              ? event.result.status
              : null,
          planRevisionId:
            typeof event.args?.planRevisionId === "string"
              ? event.args.planRevisionId
              : typeof event.result?.planRevisionId === "string"
                ? event.result.planRevisionId
                : null,
          args: event.args as unknown as Json,
          result: event.result as unknown as Json,
        })),
        chatEvents: chatEvents.map((event) => ({
          id: event.id,
          source: event.source,
          createdAt: event.createdAt,
          actionType: event.actionType,
          uiCanonical: event.uiCanonical,
          functionName: event.functionName,
          displayText: event.displayText,
          displayStatus: event.displayStatus,
          displayVariant: event.displayVariant,
          args: event.args as unknown as Json,
        })),
        streamingDelta: activeSessionId
          ? {
              length: streamingDeltaText.length,
              text: streamingDeltaText.slice(0, 500),
            }
          : null,
        pipelineItems: pipelineItems.map((item) => ({
          type: item.type,
          eventId: item.event?.id ?? null,
          functionName: item.event?.functionName ?? "",
          uiCanonical: item.event?.uiCanonical ?? "",
          actionType: item.event?.actionType ?? "",
        })),
        pipelineStats: pipelineStats as unknown as Json,
      };
    } catch (err) {
      return asError(err);
    }
  };
}
