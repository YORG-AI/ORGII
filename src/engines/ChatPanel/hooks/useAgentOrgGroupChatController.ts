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
  isGroupChatPendingDeliverySettled,
  useAgentOrgGroupChatHistory,
} from "@src/engines/ChatPanel/hooks/useAgentOrgGroupChatHistory";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { createLogger } from "@src/hooks/logger";
import { activeSessionIdAtom } from "@src/store/session";
import { groupChatViewSessionIdAtom } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ChatView");

interface GroupChatRoute {
  targetMemberId: string | null;
  body: string;
  displayText: string;
}

interface GroupChatPendingMessage {
  rowId: number;
  targetMemberId: string;
  targetMemberName: string;
  createdAt: string;
  displayText: string;
  text: string;
  inboxRow: AgentOrgInboxRuntimeRow;
}

interface UseAgentOrgGroupChatControllerOptions {
  sessionId: string;
  agentOrgRunView: AgentOrgRunView | null;
  currentAgentOrgMember: AgentOrgRunMemberView | null;
  refreshAgentOrgRunView: () => Promise<void>;
}

function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
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

function parseGroupChatRoute(
  rawText: string,
  members: ReadonlyArray<{
    memberId: string;
    name: string;
    isCoordinator: boolean;
  }>
): GroupChatRoute {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("@")) {
    return { targetMemberId: null, body: trimmed, displayText: trimmed };
  }

  const mentionText = trimmed.slice(1).trimStart();
  const mentionLower = mentionText.toLowerCase();
  const routeCandidates = members
    .flatMap((member) => {
      const labels = [member.name, member.memberId];
      if (member.isCoordinator) {
        labels.push("Coordinator");
      }
      return labels.map((label) => ({ label: label.trim(), member }));
    })
    .filter((candidate) => candidate.label.length > 0)
    .sort((left, right) => right.label.length - left.label.length);

  for (const candidate of routeCandidates) {
    const labelLower = candidate.label.toLowerCase();
    if (
      mentionLower === labelLower ||
      mentionLower.startsWith(`${labelLower} `) ||
      mentionLower.startsWith(`${labelLower}\n`)
    ) {
      return {
        targetMemberId: candidate.member.isCoordinator
          ? null
          : candidate.member.memberId,
        body: mentionText.slice(candidate.label.length).trim(),
        displayText: trimmed,
      };
    }
  }

  const tokenMatch = mentionText.match(/^(\S+)\s*(.*)$/s);
  const token = normalizeMentionToken(tokenMatch?.[1] ?? "");
  const member = members.find((candidate) => {
    const candidateNames = [candidate.memberId, candidate.name].map(
      normalizeMentionToken
    );
    return candidateNames.includes(token);
  });
  if (!member) {
    throw new Error(`Unknown Agent Team mention: @${tokenMatch?.[1] ?? ""}`);
  }
  return {
    targetMemberId: member.isCoordinator ? null : member.memberId,
    body: tokenMatch?.[2].trim() ?? "",
    displayText: trimmed,
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
  const [groupChatPendingMessage, setGroupChatPendingMessage] =
    useState<GroupChatPendingMessage | null>(null);
  const [isResumingGroupChat, setIsResumingGroupChat] = useState(false);

  useEffect(() => {
    setGroupChatPendingMessage(null);
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
        setGroupChatPendingMessage(null);
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
    if (!groupChatPendingMessage) return durableGroupChatHistoryRows;
    if (
      durableGroupChatHistoryRows.some(
        (row) => row.inboxId === groupChatPendingMessage.rowId
      )
    ) {
      return durableGroupChatHistoryRows;
    }
    return [
      ...durableGroupChatHistoryRows,
      {
        inboxId: groupChatPendingMessage.rowId,
        targetMemberId: groupChatPendingMessage.targetMemberId,
        targetMemberName: groupChatPendingMessage.targetMemberName,
        text: groupChatPendingMessage.text,
        displayText: groupChatPendingMessage.displayText,
        createdAt: groupChatPendingMessage.createdAt,
        readAt: null,
        deliveryResolution: null,
      },
    ].sort((left, right) => left.inboxId - right.inboxId);
  }, [durableGroupChatHistoryRows, groupChatPendingMessage]);

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
    if (!groupChatPendingMessage || !agentOrgRunView) return;
    const pendingRow = agentOrgRunView.inbox.find(
      (row) => row.id === groupChatPendingMessage.rowId
    );
    if (
      isGroupChatPendingDeliverySettled(
        groupChatPendingMessage.rowId,
        pendingRow,
        durableGroupChatHistoryRows
      )
    ) {
      setGroupChatPendingMessage(null);
      return;
    }

    const targetMember = agentOrgRunView.members.find(
      (member) => member.memberId === groupChatPendingMessage.targetMemberId
    );
    const targetSessionId = targetMember?.isCoordinator
      ? sessionId
      : targetMember?.sessionRuntime?.sessionId;
    const pendingCreatedAtMs = timestampMs(groupChatPendingMessage.createdAt);
    const targetHasStartedAfterMessage = groupChatMergedEvents.some((event) => {
      if (!targetSessionId || event.sessionId !== targetSessionId) return false;
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
    if (targetHasStartedAfterMessage) {
      setGroupChatPendingMessage(null);
    }
  }, [
    agentOrgRunView,
    durableGroupChatHistoryRows,
    groupChatMergedEvents,
    groupChatPendingMessage,
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

  const handleGroupChatSubmitOverride = useCallback(
    async (input: SubmitOverrideInput): Promise<boolean> => {
      if (!agentOrgRunView) return false;
      const content = input.agentContent ?? input.displayText;
      if (!groupChatViewActive && !content.trim().startsWith("@")) {
        return false;
      }
      let route: GroupChatRoute;
      try {
        route = parseGroupChatRoute(content, agentOrgRunView.members);
      } catch (err) {
        if (!groupChatViewActive) return false;
        throw err;
      }
      if (input.imageDataUrls && input.imageDataUrls.length > 0) {
        throw new Error("Group chat does not support image attachments yet");
      }
      if (!route.body.trim()) {
        throw new Error("Agent Team group chat message content is required");
      }
      const targetMember = route.targetMemberId
        ? agentOrgRunView.members.find(
            (member) => member.memberId === route.targetMemberId
          )
        : agentOrgRunView.members.find((member) => member.isCoordinator);
      if (!targetMember) {
        throw new Error("Agent Team group chat target member was not found");
      }
      const optimisticRowId = nextOptimisticInboxRowIdRef.current--;
      const optimisticRow = makeOptimisticInboxRow({
        id: optimisticRowId,
        targetMemberId: targetMember.memberId,
        targetMemberName: targetMember.name,
        targetAgentId: targetMember.agentId,
        body: route.body,
        displayText: route.displayText,
      });
      setGroupChatPendingMessage({
        rowId: optimisticRowId,
        targetMemberId: targetMember.memberId,
        targetMemberName: targetMember.name,
        createdAt: optimisticRow.createdAt,
        displayText: route.displayText,
        text: route.body,
        inboxRow: optimisticRow,
      });
      try {
        const response = await sendAgentOrgGroupChatMessage(
          sessionId,
          route.targetMemberId,
          route.body,
          route.displayText
        );
        setGroupChatPendingMessage({
          rowId: response.inboxRow.id,
          targetMemberId: response.targetMemberId,
          targetMemberName: response.targetMemberName,
          createdAt: response.inboxRow.createdAt,
          displayText: route.displayText,
          text: route.body,
          inboxRow: response.inboxRow,
        });
        void refreshAgentOrgRunView().catch((err: unknown) => {
          logger.error(
            "Failed to refresh Agent Team run after group chat send:",
            err
          );
        });
      } catch (err) {
        setGroupChatPendingMessage((current) =>
          current?.rowId === optimisticRowId ? null : current
        );
        throw err;
      }
      return true;
    },
    [agentOrgRunView, groupChatViewActive, refreshAgentOrgRunView, sessionId]
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
