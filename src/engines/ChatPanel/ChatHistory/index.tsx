/**
 * ChatHistory orchestrates session state, projection, navigation, viewport,
 * actions and the render-only view. Each concern owns its internal effects in
 * a focused hook so this entry point only wires their contracts together.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { loadEventComponent } from "@src/engines/SessionCore/rendering/registry/events";
import { usePinnedSession } from "@src/features/Org2Cloud/SessionConversation/usePinnedSession";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import { type Session, sessionByIdAtom } from "@src/store/session/sessionAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import { ParentAgentSenderProvider } from "../ChatItems/ParentAgentSenderContext";
import { SharedConversationSenderProvider } from "../ChatItems/SharedConversationSenderContext";
import { resolveParentAgentSenderSessionId } from "../ChatItems/parentAgentSender";
import { useChatSessionId } from "../ChatSessionContext";
import {
  type ChatHistoryProps,
  EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV,
  EMPTY_FOLLOW_AGENT_NAV,
} from "./ChatHistory.types";
import { useGroupChatContext } from "./GroupChatView/GroupChatContext";
import ChatHistoryView from "./components/ChatHistoryView";
import {
  useChatEmptyState,
  useChatHistoryItemActions,
  useChatHistoryProjectionModel,
  useChatHistoryState,
  useChatNavigationController,
  useChatSearch,
  useChatViewportController,
  useReloadSession,
} from "./hooks";
import "./index.scss";

export type {
  BrowserAddToConversationNavState,
  ChatHistoryProps,
  FollowAgentNavState,
  ScrollNavState,
} from "./ChatHistory.types";

const EMPTY_ORG_MEMBERS: ChatHistoryProps["agentOrgMembers"] = [];

function resolveSharedConversationSender(
  session: Session | undefined,
  remoteEntries: Record<
    string,
    { rows?: readonly RemoteTeammateSessionMetadata[] } | undefined
  >
) {
  // Pre-lineage imports recorded no owner name; the live listing row still
  // knows it, so resolve through the cloud rows before giving up on the
  // "Shared user" placeholder.
  const rowOwnerName = (orgId: string, sourceSessionId: string) =>
    remoteEntries[orgId]?.rows
      ?.find((row) => row.sourceSessionId === sourceSessionId)
      ?.ownerDisplayName?.trim();
  if (session?.importedFrom) {
    const lineage = session.importedFrom;
    return {
      displayName:
        lineage.ownerDisplayName?.trim() ||
        rowOwnerName(lineage.orgId, lineage.sourceSessionId) ||
        "Shared user",
      avatarUrl: lineage.ownerAvatarUrl,
    };
  }
  // Row-field lineage is stripped on some reload paths; the registry
  // fallback keeps the SOURCE owner's name resolvable so inherited rows
  // never regress to the "Shared user" placeholder.
  const forkedFrom = session ? getSessionForkedFrom(session) : undefined;
  if (forkedFrom) {
    return {
      displayName:
        forkedFrom.ownerDisplayName?.trim() ||
        rowOwnerName(forkedFrom.orgId, forkedFrom.sourceSessionId) ||
        "Shared user",
    };
  }
  return null;
}

const ChatHistory: React.FC<ChatHistoryProps> = ({
  surfaceBgClass = "bg-chat-pane",
  chatPanelPosition = "right",
  agentOrgCurrentMemberName = null,
  agentOrgCurrentMemberId = null,
  agentOrgMembers = EMPTY_ORG_MEMBERS,
  agentOrgOverviewPanel,
  onAgentOrgMemberSelect,
  onAgentOrgRunViewRefresh,
  onScrollNavChange,
  followAgentNav = EMPTY_FOLLOW_AGENT_NAV,
  browserAddToConversationNav = EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV,
  displayMode = "full",
  turnPaginationEnabled = true,
  pinnedHeaderPortalHost = null,
  chromeTopInset = 0,
  bottomInset = 0,
  forceCollapseAllTurns = false,
  disableTailCollapse = false,
  paginationTrailingSlot,
  hideGroupUserMessage = false,
  newEventDividerLabel = null,
  groupChatViewAvailable = false,
  groupChatViewActive = false,
  onGroupChatViewToggle,
  mutationActionsDisabled = false,
  planningIndicatorScope = null,
}) => {
  const activeId = useChatSessionId() ?? null;
  const rawCursorIdeTurnSummaries = useAtomValue(
    cursorIdeTurnSummariesAtomFamily(activeId ?? "")
  );
  const activeSession = usePinnedSession(activeId ?? "");
  const isCursorIde = activeId ? isCursorIdeSession(activeId) : false;
  const cursorIdeTurnSummaries = isCursorIde ? rawCursorIdeTurnSummaries : [];
  const handleReloadSession = useReloadSession(activeId);
  const historyState = useChatHistoryState();
  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const groupChat = useGroupChatContext();
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
  const sharedConversationSender = useMemo(
    () => resolveSharedConversationSender(activeSession, remoteEntries),
    [activeSession, remoteEntries]
  );

  useEffect(() => {
    // Canvas payloads can reach the WorkStation as soon as the tool call is
    // stored. Warm the chat renderer while the user is still waiting for the
    // agent so the persisted canvas event can take over without a Suspense
    // placeholder between the live and historical render paths.
    void loadEventComponent("canvas_inline");
  }, []);

  const [planningIndicatorCount, setPlanningIndicatorCount] = useState<0 | 1>(
    0
  );
  const handlePlanningIndicatorCount = useCallback((count: 0 | 1) => {
    setPlanningIndicatorCount((previous) =>
      previous === count ? previous : count
    );
  }, []);

  const projection = useChatHistoryProjectionModel({
    activeId,
    chatHistory: historyState.chatHistory,
    chatHistorySourceIsOverride: historyState.chatHistorySourceIsOverride,
    chatHistorySourceSessionId: historyState.chatHistorySourceSessionId,
    chatHistorySourceVersion: historyState.chatHistorySourceVersion,
    cursorIdeTurnSummaries,
    disableTailCollapse,
    forceCollapseAllTurns,
    groupChat,
    hideGroupUserMessage,
    isAgentWorking,
    planningIndicatorCount,
    sessionStatus: activeSession?.status,
    sessionLoadStatus: historyState.sessionLoadStatus,
    turnPaginationEnabled,
  });
  const navigation = useChatNavigationController({
    activeId,
    agentOrgOverviewAvailable: Boolean(agentOrgOverviewPanel),
    currentPageIndex: projection.currentPageIndex,
    displayGroupCounts: projection.displayGroupCounts,
    displayGroupHeaders: projection.displayGroupHeaders,
    displayGroupMeta: projection.displayGroupMeta,
    displaySourceGroupIndices: projection.displaySourceGroupIndices,
    displayTotalFlatItems: projection.displayTotalFlatItems,
    pages: projection.pages,
    setTurnPageListOpen: projection.setTurnPageListOpen,
    setTurnPageSortAscending: projection.setTurnPageSortAscending,
    turnPageListOpen: projection.turnPageListOpen,
    turnPaginationEnabled,
    virtualListRef: historyState.virtualListRef,
  });
  const emptyState = useChatEmptyState({
    activeSessionId: activeId,
    sessionLoadStatus: historyState.sessionLoadStatus,
    optimizedLen: historyState.chatHistory.length,
  });
  const search = useChatSearch({
    sessionId: activeId,
    chatHistory: historyState.chatHistory,
    flatItems: projection.flatItems,
    groupCounts: projection.groupCounts,
    groupMeta: projection.groupMeta,
    pages: projection.pages,
    turnPaginationEnabled,
    currentPageIndex: projection.currentPageIndex,
    setTurnPageSelection: projection.setTurnPageSelection,
    virtualListRef: historyState.virtualListRef,
    chatContainerRef: historyState.chatContainerRef,
  });

  const viewport = useChatViewportController({
    activeId,
    activeProjectionHistoryLength: projection.activeProjectionHistory.length,
    atBottom: historyState.atBottom,
    bottomInset,
    browserAddToConversationNav,
    currentPageIndex: projection.currentPageIndex,
    disableTailCollapse,
    displayGroupCounts: projection.displayGroupCounts,
    displayLastGroupFirstFlatIndex: projection.displayLastGroupFirstFlatIndex,
    displayTotalFlatItems: projection.displayTotalFlatItems,
    followAgentNav,
    isPendingCancelRef: emptyState.isPendingCancelRef,
    onScrollNavChange,
    planningIndicatorCount,
    sessionLoadStatus: historyState.sessionLoadStatus,
    setAtBottom: historyState.setAtBottom,
    setIsChatScrolledToBottom: historyState.setIsChatScrolledToBottom,
    setVisibleRange: historyState.setVisibleRange,
    tailFollowKey: projection.tailFollowKey,
    totalFlatItems: projection.totalFlatItems,
    turnPaginationEnabled,
  });
  // Agent-started sessions carry no message the reader wrote: their user-role
  // turns are the parent's dispatches. Resolve the parent once here so every
  // row renders the same attribution without its own store subscription.
  const parentAgentSessionId = useMemo(
    () =>
      activeId
        ? resolveParentAgentSenderSessionId({
            sessionId: activeId,
            parentSessionId: activeSession?.parentSessionId,
            orgMemberId: activeSession?.orgMemberId,
            background: activeSession?.background,
          })
        : null,
    [
      activeId,
      activeSession?.background,
      activeSession?.orgMemberId,
      activeSession?.parentSessionId,
    ]
  );
  const parentSession = useAtomValue(
    sessionByIdAtom(parentAgentSessionId ?? "")
  );
  const parentAgentSender = useMemo(
    () =>
      parentAgentSessionId
        ? { parentSessionId: parentAgentSessionId, parentSession }
        : null,
    [parentAgentSessionId, parentSession]
  );

  const actions = useChatHistoryItemActions({
    displaySourceGroupIndices: projection.displaySourceGroupIndices,
    groupHeaders: projection.groupHeaders,
    handleIgnoreQuestionRef: historyState.handleIgnoreQuestionRef,
    handleReplyQuestionRef: historyState.handleReplyQuestionRef,
  });

  return (
    <SharedConversationSenderProvider value={sharedConversationSender}>
      <ParentAgentSenderProvider value={parentAgentSender}>
        <ChatHistoryView
          actions={actions}
          activeId={activeId}
          agentOrgCurrentMemberId={agentOrgCurrentMemberId}
          agentOrgCurrentMemberName={agentOrgCurrentMemberName}
          agentOrgMembers={agentOrgMembers}
          agentOrgOverviewPanel={agentOrgOverviewPanel}
          bottomInset={bottomInset}
          chatPanelPosition={chatPanelPosition}
          displayMode={displayMode}
          emptyState={emptyState}
          groupChatEnabled={Boolean(groupChat?.enabled)}
          groupChatViewActive={groupChatViewActive}
          groupChatViewAvailable={groupChatViewAvailable}
          handlePlanningIndicatorCount={handlePlanningIndicatorCount}
          handleReloadSession={handleReloadSession}
          hideGroupUserMessage={hideGroupUserMessage}
          historyState={historyState}
          mutationActionsDisabled={mutationActionsDisabled}
          navigation={navigation}
          newEventDividerLabel={newEventDividerLabel}
          onAgentOrgMemberSelect={onAgentOrgMemberSelect}
          onAgentOrgRunViewRefresh={onAgentOrgRunViewRefresh}
          onGroupChatViewToggle={onGroupChatViewToggle}
          paginationTrailingSlot={paginationTrailingSlot}
          pinnedHeaderPortalHost={pinnedHeaderPortalHost}
          chromeTopInset={chromeTopInset}
          planningIndicatorScope={planningIndicatorScope}
          projection={projection}
          search={search}
          surfaceBgClass={surfaceBgClass}
          turnPaginationEnabled={turnPaginationEnabled}
          viewport={viewport}
        />
      </ParentAgentSenderProvider>
    </SharedConversationSenderProvider>
  );
};

ChatHistory.displayName = "ChatHistory";

export default ChatHistory;
