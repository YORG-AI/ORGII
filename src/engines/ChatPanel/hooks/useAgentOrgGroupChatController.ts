import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AGENT_ORG_RUN_STATUS,
  AGENT_ORG_USER_SENDER_ID,
  type AgentOrgInboxRow,
  type AgentOrgRunMemberView,
  type AgentOrgRunView,
  resumeAgentOrgRun,
  sendAgentOrgGroupChatMessage,
} from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { useGroupChatMergedEvents } from "@src/engines/ChatPanel/ChatHistory/GroupChatView/useGroupChatMergedEvents";
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
  inboxRow: AgentOrgInboxRow;
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

function isInboxRowRead(row: AgentOrgInboxRow | undefined): boolean {
  return Boolean(row?.readAt && row.readAt.trim());
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
}): AgentOrgInboxRow {
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
  const { t } = useTranslation("sessions");
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const groupChatViewSessionId = useAtomValue(groupChatViewSessionIdAtom);
  const setGroupChatViewSessionId = useSetAtom(groupChatViewSessionIdAtom);
  const groupChatDefaultAppliedRef = useRef<Set<string>>(new Set());
  const nextOptimisticInboxRowIdRef = useRef(-1);
  const [groupChatPendingMessage, setGroupChatPendingMessage] =
    useState<GroupChatPendingMessage | null>(null);
  const [groupChatDisplayOverrides, setGroupChatDisplayOverrides] = useState<
    ReadonlyMap<number, string>
  >(() => new Map());
  const [isResumingGroupChat, setIsResumingGroupChat] = useState(false);

  useEffect(() => {
    setGroupChatPendingMessage(null);
    setGroupChatDisplayOverrides(new Map());
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
        setGroupChatDisplayOverrides(new Map());
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

  const groupChatInboxRows = useMemo(() => {
    const rows = agentOrgRunView?.inbox ?? [];
    if (!groupChatPendingMessage) return rows;
    if (rows.some((row) => row.id === groupChatPendingMessage.rowId)) {
      return rows;
    }
    return [...rows, groupChatPendingMessage.inboxRow];
  }, [agentOrgRunView?.inbox, groupChatPendingMessage]);

  const {
    mergedEvents: groupChatMergedEvents,
    agents: groupChatAgents,
    handleTapEvents: handleGroupChatTapEvents,
  } = useGroupChatMergedEvents(
    groupChatViewActive ? sessionId : null,
    agentOrgRunView?.members ?? [],
    groupChatInboxRows,
    groupChatDisplayOverrides
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
    if (isInboxRowRead(pendingRow)) {
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
      Message.error(
        t("groupChat.pausedBanner.resumeFailed", {
          defaultValue: "Could not resume Agent Team run. Try again.",
        })
      );
    } finally {
      setIsResumingGroupChat(false);
    }
  }, [isResumingGroupChat, refreshAgentOrgRunView, sessionId, t]);

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
      setGroupChatDisplayOverrides((prev) => {
        const next = new Map(prev);
        next.set(optimisticRowId, route.displayText);
        return next;
      });
      setGroupChatPendingMessage({
        rowId: optimisticRowId,
        targetMemberId: targetMember.memberId,
        targetMemberName: targetMember.name,
        createdAt: optimisticRow.createdAt,
        displayText: route.displayText,
        inboxRow: optimisticRow,
      });
      try {
        const response = await sendAgentOrgGroupChatMessage(
          sessionId,
          route.targetMemberId,
          route.body
        );
        setGroupChatDisplayOverrides((prev) => {
          const next = new Map(prev);
          next.delete(optimisticRowId);
          next.set(response.inboxRow.id, route.displayText);
          return next;
        });
        setGroupChatPendingMessage({
          rowId: response.inboxRow.id,
          targetMemberId: response.targetMemberId,
          targetMemberName: response.targetMemberName,
          createdAt: response.inboxRow.createdAt,
          displayText: route.displayText,
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
        setGroupChatDisplayOverrides((prev) => {
          const next = new Map(prev);
          next.delete(optimisticRowId);
          return next;
        });
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
    isResumingGroupChat,
    handleResumeGroupChatRun,
    handleGroupChatViewToggle,
    handleGroupChatSubmitOverride,
  };
}
