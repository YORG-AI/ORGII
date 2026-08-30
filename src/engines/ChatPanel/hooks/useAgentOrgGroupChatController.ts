import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AGENT_ORG_RUN_STATUS,
  AGENT_ORG_USER_SENDER_ID,
  type AgentOrgGroupChatHistoryRow,
  type AgentOrgGroupDeliveryInput,
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
import { SubmissionOutcomeUnknownError } from "@src/engines/ChatPanel/hooks/useInputArea/submissionErrors";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { createLogger } from "@src/hooks/logger";
import { activeSessionIdAtom } from "@src/store/session";
import { groupChatViewSessionIdAtom } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ChatView");

interface GroupChatPendingMessage {
  rowId: number;
  turnIntentId: string;
  targetMemberId: string;
  targetMemberName: string;
  createdAt: string;
  displayText: string;
  text: string;
  inboxRow: AgentOrgInboxRuntimeRow;
}

export interface GroupChatRetryEnvelope {
  fingerprint: string;
  deliveries: AgentOrgGroupDeliveryInput[];
  content: string;
  displayText: string;
  images?: string[];
  targetMemberNames: string[];
}

export function groupChatRetryRequest(envelope: GroupChatRetryEnvelope): {
  deliveries: AgentOrgGroupDeliveryInput[];
  content: string;
  displayText: string;
  images?: string[];
} {
  return {
    deliveries: envelope.deliveries.map((delivery) => ({ ...delivery })),
    content: envelope.content,
    displayText: envelope.displayText,
    images: envelope.images?.slice(),
  };
}

export function isDurableGroupDeliveryOutcomeUnknown(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("group_delivery_commit_before_kick_fault") ||
    message.includes("group_delivery_response_loss_after_kick_fault") ||
    message.includes("group_delivery_kick_failed")
  );
}

interface UseAgentOrgGroupChatControllerOptions {
  sessionId: string;
  agentOrgRunView: AgentOrgRunView | null;
  currentAgentOrgMember: AgentOrgRunMemberView | null;
  refreshAgentOrgRunView: () => Promise<void>;
}

export function isDirectAgentOrgMemberView(
  currentAgentOrgMember: AgentOrgRunMemberView | null
): boolean {
  return currentAgentOrgMember !== null && !currentAgentOrgMember.isCoordinator;
}

export function shouldRouteAgentOrgGroupChatSubmit(
  groupChatViewActive: boolean,
  directMemberView: boolean,
  memberMentionCount: number
): boolean {
  if (directMemberView) return false;
  return groupChatViewActive || memberMentionCount > 0;
}

/**
 * Root/Coordinator Group messages are ordinary Root conversation turns. They
 * must fall through to the canonical user-intent queue so Idle follow-ups can
 * answer or create a new work episode, and busy follow-ups retain their FIFO
 * identity. The Group Inbox transport is reserved for an explicit Member
 * target; using it for Root messages creates an unread row plus an empty
 * wake that the Coordinator cannot claim.
 */
export function shouldUseAgentOrgMemberGroupTransport(
  targetMemberIds: ReadonlyArray<string>
): boolean {
  return targetMemberIds.length > 0;
}

export function shouldBlockPausedAgentOrgGroupChatSubmit(
  runStatus: AgentOrgRunView["runStatus"],
  targetMemberIds: ReadonlyArray<string>
): boolean {
  return (
    runStatus === AGENT_ORG_RUN_STATUS.PAUSED && targetMemberIds.length === 0
  );
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
  const groupChatRetryEnvelopeRef = useRef<GroupChatRetryEnvelope | null>(null);
  const [groupChatRetryError, setGroupChatRetryError] = useState<string | null>(
    null
  );
  const [isRetryingGroupChat, setIsRetryingGroupChat] = useState(false);
  const [isResumingGroupChat, setIsResumingGroupChat] = useState(false);

  useEffect(() => {
    setGroupChatPendingMessages([]);
    groupChatRetryEnvelopeRef.current = null;
    setGroupChatRetryError(null);
    setIsRetryingGroupChat(false);
  }, [sessionId]);

  const directMemberView = isDirectAgentOrgMemberView(currentAgentOrgMember);
  const groupChatViewActive =
    groupChatViewSessionId === sessionId && !directMemberView;
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
    if (groupChatPendingMessages.length === 0)
      return durableGroupChatHistoryRows;
    const durableIds = new Set(
      durableGroupChatHistoryRows.map((row) => row.inboxId)
    );
    return [
      ...durableGroupChatHistoryRows,
      ...groupChatPendingMessages
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
        })),
    ].sort((left, right) => left.inboxId - right.inboxId);
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
    setGroupChatPendingMessages((current) => {
      const remaining = current.filter((pending) => {
        const pendingRow = agentOrgRunView.inbox.find(
          (row) => row.id === pending.rowId
        );
        return !isGroupChatPendingDeliverySettled(
          pending.rowId,
          pendingRow,
          durableGroupChatHistoryRows
        );
      });
      return remaining.length === current.length ? current : remaining;
    });
  }, [agentOrgRunView, durableGroupChatHistoryRows, groupChatPendingMessages]);

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

  const handleGroupChatSubmitOverride = useCallback(
    async (input: SubmitOverrideInput): Promise<boolean> => {
      if (!agentOrgRunView) return false;
      if (
        !shouldRouteAgentOrgGroupChatSubmit(
          groupChatViewActive,
          directMemberView,
          input.memberMentions?.length ?? 0
        )
      ) {
        return false;
      }
      const route: GroupChatOutgoing = resolveGroupChatOutgoing(
        {
          displayText: input.displayText,
          memberMentions: input.memberMentions ?? [],
          displayTextWithoutMemberMentions:
            input.displayTextWithoutMemberMentions ?? input.displayText,
          agentContentWithoutMemberMentions:
            input.agentContentWithoutMemberMentions ??
            input.displayTextWithoutMemberMentions ??
            input.agentContent ??
            input.displayText,
        },
        agentOrgRunView.members
      );
      if (!shouldUseAgentOrgMemberGroupTransport(route.targetMemberIds)) {
        // The ordinary submit path already targets `sessionId`, which is the
        // canonical Root while Group Chat is active. It owns durable queueing,
        // Turn identity, EventStore persistence, busy-session FIFO, restart
        // recovery, and provider observation for this user fact.
        return false;
      }
      if (!route.agentBody.trim()) {
        throw new Error("Agent Team group chat message content is required");
      }
      if (
        shouldBlockPausedAgentOrgGroupChatSubmit(
          agentOrgRunView.runStatus,
          route.targetMemberIds
        )
      ) {
        throw new Error("Resume this Agent Team before sending a Root message");
      }
      const targets = route.targetMemberIds.map((memberId) => {
        const member = agentOrgRunView.members.find(
          (candidate) => candidate.memberId === memberId
        );
        if (!member || member.isCoordinator) {
          throw new Error(`Agent Team Member ${memberId} was not found`);
        }
        return member;
      });
      const fingerprint = JSON.stringify({
        targets: route.targetMemberIds,
        body: route.agentBody,
        displayText: route.displayText,
        images: input.imageDataUrls ?? [],
      });
      let envelope = groupChatRetryEnvelopeRef.current;
      if (!envelope || envelope.fingerprint !== fingerprint) {
        envelope = {
          fingerprint,
          deliveries: targets.map((member) => ({
            targetMemberId: member.memberId,
            turnIntentId: crypto.randomUUID(),
          })),
          content: route.agentBody,
          displayText: route.displayText,
          images: input.imageDataUrls?.slice(),
          targetMemberNames: targets.map((member) => member.name),
        };
        groupChatRetryEnvelopeRef.current = envelope;
        setGroupChatRetryError(null);
      }
      const optimistic = envelope.deliveries.map((delivery) => {
        const target = targets.find(
          (member) => member.memberId === delivery.targetMemberId
        );
        if (!target) throw new Error("Group delivery target changed");
        const existing = groupChatPendingMessages.find(
          (pending) => pending.turnIntentId === delivery.turnIntentId
        );
        if (existing) return existing;
        const row = makeOptimisticInboxRow({
          id: nextOptimisticInboxRowIdRef.current--,
          targetMemberId: target.memberId,
          targetMemberName: target.name,
          targetAgentId: target.agentId,
          body: route.agentBody,
          displayText: route.displayText,
        });
        return {
          rowId: row.id,
          turnIntentId: delivery.turnIntentId,
          targetMemberId: target.memberId,
          targetMemberName: target.name,
          createdAt: row.createdAt,
          displayText: route.displayText,
          text: route.agentBody,
          inboxRow: row,
        };
      });
      setGroupChatPendingMessages(optimistic);
      // A rejected transport leaves the immutable envelope and optimistic
      // rows untouched. The explicit Retry action below replays this exact
      // request, including the original per-target Turn ids.
      let response;
      try {
        const request = groupChatRetryRequest(envelope);
        response = await sendAgentOrgGroupChatMessage(
          sessionId,
          request.deliveries,
          request.content,
          request.displayText,
          request.images
        );
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!isDurableGroupDeliveryOutcomeUnknown(err)) {
          groupChatRetryEnvelopeRef.current = null;
          setGroupChatPendingMessages([]);
          setGroupChatRetryError(null);
          throw err;
        }
        setGroupChatRetryError(reason || "Group delivery outcome is unknown");
        logger.warn(
          "Agent Team group delivery outcome is unknown; preserving retry envelope:",
          err
        );
        throw new SubmissionOutcomeUnknownError(
          reason || "Group delivery outcome is unknown"
        );
      }
      groupChatRetryEnvelopeRef.current = null;
      setGroupChatRetryError(null);
      setGroupChatPendingMessages(
        response.deliveries.map((delivery) => ({
          rowId: delivery.inboxRow.id,
          turnIntentId: delivery.turnIntentId,
          targetMemberId: delivery.targetMemberId,
          targetMemberName: delivery.targetMemberName,
          createdAt: delivery.inboxRow.createdAt,
          displayText: route.displayText,
          text: route.agentBody,
          inboxRow: delivery.inboxRow,
        }))
      );
      void refreshAgentOrgRunView().catch((err: unknown) => {
        logger.error(
          "Failed to refresh Agent Team run after group chat send:",
          err
        );
      });
      return true;
    },
    [
      agentOrgRunView,
      directMemberView,
      groupChatViewActive,
      refreshAgentOrgRunView,
      sessionId,
      groupChatPendingMessages,
    ]
  );

  const handleRetryGroupChatMessage = useCallback(async () => {
    const envelope = groupChatRetryEnvelopeRef.current;
    if (!envelope || isRetryingGroupChat) return;
    setIsRetryingGroupChat(true);
    try {
      const request = groupChatRetryRequest(envelope);
      const response = await sendAgentOrgGroupChatMessage(
        sessionId,
        request.deliveries,
        request.content,
        request.displayText,
        request.images
      );
      groupChatRetryEnvelopeRef.current = null;
      setGroupChatRetryError(null);
      setGroupChatPendingMessages(
        response.deliveries.map((delivery) => ({
          rowId: delivery.inboxRow.id,
          turnIntentId: delivery.turnIntentId,
          targetMemberId: delivery.targetMemberId,
          targetMemberName: delivery.targetMemberName,
          createdAt: delivery.inboxRow.createdAt,
          displayText: envelope.displayText,
          text: envelope.content,
          inboxRow: delivery.inboxRow,
        }))
      );
      await refreshAgentOrgRunView();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      setGroupChatRetryError(reason || "Group delivery outcome is unknown");
      logger.warn(
        "Agent Team group delivery retry failed; preserving retry envelope:",
        err
      );
    } finally {
      setIsRetryingGroupChat(false);
    }
  }, [isRetryingGroupChat, refreshAgentOrgRunView, sessionId]);

  const groupChatPendingMessage = useMemo(() => {
    const retryEnvelope = groupChatRetryEnvelopeRef.current;
    if (groupChatRetryError && retryEnvelope) {
      return {
        targetMemberName:
          retryEnvelope.targetMemberNames.length > 1
            ? `${retryEnvelope.targetMemberNames.length} Members`
            : (retryEnvelope.targetMemberNames[0] ?? "Member"),
        retryError: groupChatRetryError,
        retrying: isRetryingGroupChat,
        onRetry: handleRetryGroupChatMessage,
      };
    }
    const pending = groupChatPendingMessages[0];
    if (!pending) return null;
    return {
      ...pending,
      targetMemberName:
        groupChatPendingMessages.length > 1
          ? `${groupChatPendingMessages.length} Members`
          : pending.targetMemberName,
      retryError: null,
      retrying: false,
      onRetry: handleRetryGroupChatMessage,
    };
  }, [
    groupChatPendingMessages,
    groupChatRetryError,
    handleRetryGroupChatMessage,
    isRetryingGroupChat,
  ]);

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
    groupChatPendingMessage,
    groupChatHistoryHasMore,
    groupChatHistoryLoading,
    groupChatHistoryError,
    loadOlderGroupChatHistory,
    retryGroupChatHistory,
    isResumingGroupChat,
    handleResumeGroupChatRun,
    handleGroupChatViewToggle,
    handleGroupChatSubmitOverride,
  };
}
