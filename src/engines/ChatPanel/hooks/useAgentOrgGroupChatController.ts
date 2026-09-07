import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AGENT_ORG_RUN_STATUS,
  AGENT_ORG_USER_SENDER_ID,
  type AgentOrgGroupChatHistoryRow,
  type AgentOrgInboxRuntimeRow,
  type AgentOrgRunMemberView,
  type AgentOrgRunView,
  resumeAgentOrgRun,
  sendAgentOrgGroupChatMessage,
} from "@src/api/tauri/agent";
import { useGroupChatMergedEvents } from "@src/engines/ChatPanel/ChatHistory/GroupChatView/useGroupChatMergedEvents";
import {
  type GroupChatOutgoing,
  resolveGroupChatOutgoing,
} from "@src/engines/ChatPanel/hooks/groupChatRouting";
import {
  isGroupChatPendingDeliverySettled,
  useAgentOrgGroupChatHistory,
} from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatHistory";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import {
  SubmitRetainedDeliveryError,
  SubmitValidationError,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { createLogger } from "@src/hooks/logger";
import { activeSessionIdAtom } from "@src/store/session";
import { groupChatViewSessionIdAtom } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ChatView");

interface GroupChatPendingMessage {
  /** Stable across retries so the recipient inbox can deduplicate delivery. */
  messageId: string;
  rowId: number;
  targetMemberId: string;
  targetMemberName: string;
  createdAt: string;
  displayText: string;
  text: string;
  inboxRow: AgentOrgInboxRuntimeRow;
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryError: string | null;
}

interface UseAgentOrgGroupChatControllerOptions {
  sessionId: string;
  agentOrgRunView: AgentOrgRunView | null;
  currentAgentOrgMember: AgentOrgRunMemberView | null;
  refreshAgentOrgRunView: () => Promise<void>;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function makeOptimisticInboxRow({
  id,
  targetMemberId,
  targetMemberName,
  targetAgentId,
  body,
  displayText,
}: {
  id: number;
  targetMemberId: string;
  targetMemberName: string;
  targetAgentId: string;
  body: string;
  displayText: string;
}): AgentOrgInboxRuntimeRow {
  const createdAt = new Date().toISOString();
  return {
    id,
    recipientAgentId: targetAgentId,
    recipientMemberId: targetMemberId,
    senderAgentId: AGENT_ORG_USER_SENDER_ID,
    senderMemberId: null,
    recipientName: targetMemberName,
    senderName: "User",
    displayText,
    orgRunId: null,
    payloadKind: "plain",
    payloadJson: JSON.stringify({
      summary: "User group chat message",
      text: body,
    }),
    requestId: null,
    createdAt,
    readAt: null,
  };
}

export function useAgentOrgGroupChatController({
  sessionId,
  agentOrgRunView,
  currentAgentOrgMember,
  refreshAgentOrgRunView,
}: UseAgentOrgGroupChatControllerOptions) {
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const groupChatViewSessionId = useAtomValue(groupChatViewSessionIdAtom);
  const setGroupChatViewSessionId = useSetAtom(groupChatViewSessionIdAtom);
  const groupChatDefaultAppliedRef = useRef<Set<string>>(new Set());
  const nextOptimisticInboxRowIdRef = useRef(-1);
  const [groupChatPendingMessages, setGroupChatPendingMessages] = useState<
    GroupChatPendingMessage[]
  >([]);
  const [isResumingGroupChat, setIsResumingGroupChat] = useState(false);

  useEffect(() => {
    setGroupChatPendingMessages([]);
  }, [sessionId]);

  const groupChatViewActive = groupChatViewSessionId === sessionId;
  const agentOrgInteractionSessionId =
    currentAgentOrgMember?.sessionRuntime?.sessionId ?? sessionId;
  const queueSessionId = groupChatViewActive
    ? sessionId
    : agentOrgInteractionSessionId;

  const groupChatViewAvailable = useMemo(
    () => Boolean(agentOrgRunView),
    [agentOrgRunView]
  );

  const handleGroupChatViewToggle = useCallback(
    (active: boolean) => {
      groupChatDefaultAppliedRef.current.add(sessionId);
      if (!active) {
        setGroupChatPendingMessages([]);
      } else {
        setActiveSessionId(sessionId);
      }
      setGroupChatViewSessionId(active ? sessionId : null);
    },
    [sessionId, setActiveSessionId, setGroupChatViewSessionId]
  );

  useEffect(() => {
    if (!sessionId || !groupChatViewAvailable) return;
    if (groupChatDefaultAppliedRef.current.has(sessionId)) return;
    groupChatDefaultAppliedRef.current.add(sessionId);
    setGroupChatViewSessionId(sessionId);
  }, [groupChatViewAvailable, sessionId, setGroupChatViewSessionId]);

  useEffect(() => {
    if (groupChatViewActive && !groupChatViewAvailable) {
      setGroupChatViewSessionId(null);
    }
  }, [groupChatViewActive, groupChatViewAvailable, setGroupChatViewSessionId]);

  const groupChatHistoryRefreshToken = useMemo(() => {
    const rows = agentOrgRunView?.inbox ?? [];
    return rows
      .filter((row) => row.senderAgentId === AGENT_ORG_USER_SENDER_ID)
      .map(
        (row) => `${row.id}:${row.readAt ?? ""}:${row.deliveryResolution ?? ""}`
      )
      .join("|");
  }, [agentOrgRunView?.inbox]);
  const {
    rows: durableGroupChatHistoryRows,
    hasMore: groupChatHistoryHasMore,
    loading: groupChatHistoryLoading,
    error: groupChatHistoryError,
    loadOlder: loadOlderGroupChatHistory,
    retry: retryGroupChatHistory,
  } = useAgentOrgGroupChatHistory(
    sessionId,
    groupChatViewActive,
    groupChatHistoryRefreshToken
  );
  const groupChatHistoryRows = useMemo<AgentOrgGroupChatHistoryRow[]>(() => {
    const durableIds = new Set(
      durableGroupChatHistoryRows.map((row) => row.inboxId)
    );
    const optimisticRows = groupChatPendingMessages
      .filter((pending) => !durableIds.has(pending.rowId))
      .map((pending) => ({
        inboxId: pending.rowId,
        targetMemberId: pending.targetMemberId,
        targetMemberName: pending.targetMemberName,
        text: pending.text,
        displayText: pending.displayText,
        createdAt: pending.createdAt,
        readAt: null,
        deliveryResolution: null,
        clientDeliveryStatus: pending.deliveryStatus,
        clientDeliveryError: pending.deliveryError,
      }));
    return [...durableGroupChatHistoryRows, ...optimisticRows].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.inboxId - right.inboxId
    );
  }, [durableGroupChatHistoryRows, groupChatPendingMessages]);

  const {
    mergedEvents: groupChatMergedEvents,
    agents: groupChatAgents,
    handleTapEvents: handleGroupChatTapEvents,
  } = useGroupChatMergedEvents(
    groupChatViewActive ? sessionId : null,
    agentOrgRunView?.members ?? [],
    groupChatHistoryRows,
    agentOrgRunView?.inbox ?? []
  );

  const groupChatMentionOptions = useMemo<ReadonlyArray<CustomMentionOption>>(
    () =>
      groupChatViewActive
        ? (agentOrgRunView?.members ?? []).map((member) => ({
            id: member.memberId,
            label: member.name,
            description: member.isCoordinator ? "Coordinator" : member.role,
          }))
        : [],
    [agentOrgRunView?.members, groupChatViewActive]
  );

  const groupChatRunPaused =
    groupChatViewActive &&
    agentOrgRunView?.runStatus === AGENT_ORG_RUN_STATUS.PAUSED;

  useEffect(() => {
    if (groupChatPendingMessages.length === 0 || !agentOrgRunView) return;
    setGroupChatPendingMessages((current) =>
      current.filter((pending) => {
        const pendingRow = agentOrgRunView.inbox.find(
          (row) => row.id === pending.rowId
        );
        if (
          isGroupChatPendingDeliverySettled(
            pending.rowId,
            pendingRow,
            durableGroupChatHistoryRows
          )
        ) {
          return false;
        }
        const targetMember = agentOrgRunView.members.find(
          (member) => member.memberId === pending.targetMemberId
        );
        const targetSessionId = targetMember?.isCoordinator
          ? sessionId
          : targetMember?.sessionRuntime?.sessionId;
        const pendingCreatedAtMs = timestampMs(pending.createdAt);
        return !groupChatMergedEvents.some((event) => {
          if (!targetSessionId || event.sessionId !== targetSessionId) {
            return false;
          }
          const eventMs = timestampMs(event.createdAt);
          return (
            eventMs !== null &&
            pendingCreatedAtMs !== null &&
            eventMs >= pendingCreatedAtMs &&
            (event.source === "assistant" ||
              event.args?.agentOrgInboxTranscript === true ||
              event.result?.agentOrgInboxTranscript === true)
          );
        });
      })
    );
  }, [
    agentOrgRunView,
    durableGroupChatHistoryRows,
    groupChatMergedEvents,
    groupChatPendingMessages.length,
    sessionId,
  ]);

  const handleResumeGroupChatRun = useCallback(async () => {
    if (!sessionId || isResumingGroupChat) return;
    setIsResumingGroupChat(true);
    try {
      await resumeAgentOrgRun(sessionId);
      await refreshAgentOrgRunView();
    } catch (err: unknown) {
      logger.error("Failed to resume Agent Team run from group chat:", err);
    } finally {
      setIsResumingGroupChat(false);
    }
  }, [isResumingGroupChat, refreshAgentOrgRunView, sessionId]);

  const deliverPendingGroupChatMessage = useCallback(
    async (pendingMessage: GroupChatPendingMessage): Promise<void> => {
      try {
        const response = await sendAgentOrgGroupChatMessage(
          sessionId,
          pendingMessage.messageId,
          pendingMessage.targetMemberId,
          pendingMessage.text,
          pendingMessage.displayText
        );
        setGroupChatPendingMessages((current) =>
          current.map((pending) =>
            pending.rowId === pendingMessage.rowId
              ? {
                  messageId: pendingMessage.messageId,
                  rowId: response.inboxRow.id,
                  targetMemberId: response.targetMemberId,
                  targetMemberName: response.targetMemberName,
                  createdAt: response.inboxRow.createdAt,
                  displayText: pendingMessage.displayText,
                  text: pendingMessage.text,
                  inboxRow: response.inboxRow,
                  deliveryStatus: "sent",
                  deliveryError: null,
                }
              : pending
          )
        );
        void refreshAgentOrgRunView().catch((err: unknown) => {
          logger.error(
            "Failed to refresh Agent Team run after group chat send:",
            err
          );
        });
      } catch (err) {
        setGroupChatPendingMessages((current) =>
          current.map((pending) =>
            pending.rowId === pendingMessage.rowId
              ? {
                  ...pending,
                  deliveryStatus: "failed",
                  deliveryError:
                    err instanceof Error ? err.message : String(err),
                }
              : pending
          )
        );
        throw new SubmitRetainedDeliveryError(err);
      }
    },
    [refreshAgentOrgRunView, sessionId]
  );

  const handleGroupChatSubmitOverride = useCallback(
    async (input: SubmitOverrideInput): Promise<boolean> => {
      if (!agentOrgRunView) return false;
      // Route on the DISPLAY copy: the `@member` header is what the user
      // typed and what the transcript renders. The agent copy may have been
      // rewritten by an interceptor (canvas contract) and must only feed the
      // member-inbox body — resolveGroupChatOutgoing owns that split.
      if (!groupChatViewActive && !input.displayText.trim().startsWith("@")) {
        return false;
      }
      let route: GroupChatOutgoing;
      try {
        route = resolveGroupChatOutgoing(input, agentOrgRunView.members);
      } catch (err) {
        if (!groupChatViewActive) return false;
        throw new SubmitValidationError(
          err instanceof Error ? err.message : String(err)
        );
      }
      if (input.imageDataUrls && input.imageDataUrls.length > 0) {
        throw new SubmitValidationError(
          "Group chat does not support image attachments yet"
        );
      }
      if (!route.agentBody.trim()) {
        throw new SubmitValidationError(
          "Agent Team group chat message content is required"
        );
      }
      const targetMember = route.targetMemberId
        ? agentOrgRunView.members.find(
            (member) => member.memberId === route.targetMemberId
          )
        : agentOrgRunView.members.find((member) => member.isCoordinator);
      if (!targetMember) {
        throw new SubmitValidationError(
          "Agent Team group chat target member was not found"
        );
      }
      const optimisticRowId = nextOptimisticInboxRowIdRef.current--;
      const optimisticRow = makeOptimisticInboxRow({
        id: optimisticRowId,
        targetMemberId: targetMember.memberId,
        targetMemberName: targetMember.name,
        targetAgentId: targetMember.agentId,
        body: route.agentBody,
        displayText: route.displayText,
      });
      const pendingMessage: GroupChatPendingMessage = {
        messageId: crypto.randomUUID(),
        rowId: optimisticRowId,
        targetMemberId: targetMember.memberId,
        targetMemberName: targetMember.name,
        createdAt: optimisticRow.createdAt,
        displayText: route.displayText,
        text: route.agentBody,
        inboxRow: optimisticRow,
        deliveryStatus: "pending",
        deliveryError: null,
      };
      setGroupChatPendingMessages((current) => [...current, pendingMessage]);
      await deliverPendingGroupChatMessage(pendingMessage);
      return true;
    },
    [agentOrgRunView, deliverPendingGroupChatMessage, groupChatViewActive]
  );

  const retryFailedGroupChatMessage = useCallback(
    async (rowId: number, editedDisplayText?: string): Promise<void> => {
      const failed = groupChatPendingMessages.find(
        (pending) =>
          pending.rowId === rowId && pending.deliveryStatus === "failed"
      );
      if (!failed || !agentOrgRunView) return;
      let next = failed;
      if (editedDisplayText !== undefined) {
        const route = resolveGroupChatOutgoing(
          {
            displayText: editedDisplayText,
            agentContent: editedDisplayText,
          },
          agentOrgRunView.members
        );
        const targetMember = route.targetMemberId
          ? agentOrgRunView.members.find(
              (member) => member.memberId === route.targetMemberId
            )
          : agentOrgRunView.members.find((member) => member.isCoordinator);
        if (!targetMember || !route.agentBody.trim()) return;
        next = {
          ...failed,
          targetMemberId: targetMember.memberId,
          targetMemberName: targetMember.name,
          displayText: route.displayText,
          text: route.agentBody,
        };
      }
      next = { ...next, deliveryStatus: "pending", deliveryError: null };
      setGroupChatPendingMessages((current) =>
        current.map((pending) => (pending.rowId === rowId ? next : pending))
      );
      await deliverPendingGroupChatMessage(next).catch((err: unknown) => {
        logger.error("Failed to retry Agent Team group chat message:", err);
      });
    },
    [agentOrgRunView, deliverPendingGroupChatMessage, groupChatPendingMessages]
  );

  return {
    agentOrgInteractionSessionId,
    queueSessionId,
    groupChatViewActive,
    groupChatViewAvailable,
    groupChatMergedEvents,
    groupChatAgents,
    handleGroupChatTapEvents,
    groupChatMentionOptions,
    groupChatRunPaused,
    groupChatPendingMessage:
      groupChatPendingMessages[groupChatPendingMessages.length - 1] ?? null,
    groupChatHistoryHasMore,
    groupChatHistoryLoading,
    groupChatHistoryError,
    loadOlderGroupChatHistory,
    retryGroupChatHistory,
    isResumingGroupChat,
    handleResumeGroupChatRun,
    handleGroupChatViewToggle,
    handleGroupChatSubmitOverride,
    retryFailedGroupChatMessage,
  };
}
